import path from "node:path";
import express, { type Express } from "express";
import pinoHttp from "pino-http";
import type { Logger } from "pino";

import type { Config } from "./config";
import { securityMiddleware } from "./middleware/security";
import { ipfsRouter } from "./routes/ipfs";
import { emergencyRouter } from "./routes/emergency";
import { anchorRouter } from "./routes/anchor";
import { zkRouter } from "./routes/zk";
import { paymentsRouter } from "./routes/payments";
import { usageRouter } from "./routes/usage";
import { healthRouter } from "./routes/health";
import { buildUsageService, type UsageService } from "./services/usage";
import { errorHandler } from "./util/errors";
import {
  buildPinningProvider,
  type PinningProvider,
} from "./services/ipfs";
import { buildDispatcher, type Dispatcher } from "./services/dispatch";
import { buildAnchorService, type AnchorService } from "./services/anchor";
import { buildBitcoinAnchorService, type BitcoinAnchorService } from "./services/bitcoin";
import { buildZkService, type ZkService } from "./services/zk";
import { buildPayments, type Payments } from "./services/payments";

export interface ServerDeps {
  cfg: Config;
  logger: Logger;
  pinning?: PinningProvider; // injectable for tests
  dispatcher?: Dispatcher;
  anchor?: AnchorService;
  bitcoin?: BitcoinAnchorService;
  zk?: ZkService;
  payments?: Payments;
  usage?: UsageService; // injectable for tests (e.g. an in-memory db)
}

/**
 * Build the Express app without starting the listener. Tests use this
 * directly with `supertest`. `index.ts` wraps it in `app.listen(...)`.
 */
export function buildApp(deps: ServerDeps): {
  app: Express;
  pinning: PinningProvider;
  dispatcher: Dispatcher;
  anchor: AnchorService;
  bitcoin: BitcoinAnchorService;
  zk: ZkService;
  payments: Payments;
  usage: UsageService | null;
} {
  const pinning = deps.pinning ?? buildPinningProvider(deps.cfg);
  const dispatcher = deps.dispatcher ?? buildDispatcher(deps.cfg);
  const anchor = deps.anchor ?? buildAnchorService(deps.cfg, deps.logger);
  const bitcoin = deps.bitcoin ?? buildBitcoinAnchorService(deps.logger);
  const zk = deps.zk ?? buildZkService(deps.cfg, deps.logger);
  const payments = deps.payments ?? buildPayments(deps.cfg, anchor.rpcUrl);
  const usage =
    deps.usage ??
    (deps.cfg.USAGE_ENABLED
      ? buildUsageService(
          {
            dbPath: deps.cfg.USAGE_DB_PATH,
            maxSkewMs: deps.cfg.USAGE_MAX_SKEW_MS,
            nonceRetentionMs: deps.cfg.USAGE_NONCE_RETENTION_MS,
            libsqlUrl: deps.cfg.USAGE_LIBSQL_URL || undefined,
            libsqlAuthToken: deps.cfg.USAGE_LIBSQL_AUTH_TOKEN || undefined,
          },
          deps.logger,
        )
      : null);
  const app = express();

  app.set("trust proxy", deps.cfg.NODE_ENV === "production" ? 1 : false);
  app.disable("x-powered-by");

  // Logger first so it captures everything that follows.
  app.use(
    pinoHttp({
      logger: deps.logger,
      // Do not access-log usage submissions: it keeps client IPs out of the
      // application logs, so usage tracking can never become an IP analytics
      // system. (Health checks are also skipped.)
      autoLogging: { ignore: (req) => req.url === "/livez" || req.url === "/v1/usage" },
    }),
  );

  // Security stack (helmet, cors).
  for (const mw of securityMiddleware(deps.cfg)) app.use(mw);

  // JSON parser for endpoints that take JSON. Note: /v1/pin reads raw bytes
  // and is mounted before `express.json()` would otherwise consume the body.
  app.use("/v1/pin", express.raw({ type: "application/octet-stream", limit: deps.cfg.MAX_BLOB_BYTES }));
  // Stripe webhook needs the raw body for signature verification — mount before json.
  app.use("/v1/pay/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }));
  app.use(express.json({ limit: "256kb" }));

  // Health
  app.use("/", healthRouter({ pinning, dispatcher, startedAt: Date.now() }));

  // Versioned API. Each router applies its own rate limit so that pin and
  // emergency budgets are independent.
  app.use("/v1", ipfsRouter({ cfg: deps.cfg, pinning }));
  app.use("/v1/emergency", emergencyRouter({ cfg: deps.cfg, dispatcher }));
  app.use("/v1/anchor", anchorRouter({ cfg: deps.cfg, anchor, bitcoin }));
  app.use("/v1/zk", zkRouter({ cfg: deps.cfg, zk }));
  app.use("/v1/pay", paymentsRouter({ cfg: deps.cfg, payments }));
  if (usage) {
    app.use("/v1/usage", usageRouter({ cfg: deps.cfg, usage, anchor }));
    // Standalone public verification page (neutral, aggregate-only, self-
    // contained HTML). Served at /usage. The global helmet CSP is `default-src
    // 'none'`, which blocks this page's inline script/style; override it with a
    // tailored policy for just this response. Inline is acceptable here: the
    // page takes no user input, sets no cookies, holds no secrets, and renders
    // only server-provided aggregate numbers. connect-src permits the same-
    // origin report API plus the public Solana RPCs used for the on-chain check.
    app.get("/usage", (_req, res) => {
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'none'",
          "script-src 'unsafe-inline'",
          "style-src 'unsafe-inline'",
          "connect-src 'self' https://api.devnet.solana.com https://api.mainnet-beta.solana.com https://api.testnet.solana.com",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
      );
      res.sendFile(path.join(process.cwd(), "public", "usage.html"));
    });
  }

  // Catch-all 404 (after routes).
  app.use((_req, res) => res.status(404).json({ error: "not found", code: "not_found" }));

  // Global error handler — must be last.
  app.use(errorHandler);

  return { app, pinning, dispatcher, anchor, bitcoin, zk, payments, usage };
}
