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
import { healthRouter } from "./routes/health";
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
} {
  const pinning = deps.pinning ?? buildPinningProvider(deps.cfg);
  const dispatcher = deps.dispatcher ?? buildDispatcher(deps.cfg);
  const anchor = deps.anchor ?? buildAnchorService(deps.cfg, deps.logger);
  const bitcoin = deps.bitcoin ?? buildBitcoinAnchorService(deps.logger);
  const zk = deps.zk ?? buildZkService(deps.cfg, deps.logger);
  const payments = deps.payments ?? buildPayments(deps.cfg, anchor.rpcUrl);
  const app = express();

  app.set("trust proxy", deps.cfg.NODE_ENV === "production" ? 1 : false);
  app.disable("x-powered-by");

  // Logger first so it captures everything that follows.
  app.use(
    pinoHttp({
      logger: deps.logger,
      autoLogging: { ignore: (req) => req.url === "/livez" },
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

  // Catch-all 404 (after routes).
  app.use((_req, res) => res.status(404).json({ error: "not found", code: "not_found" }));

  // Global error handler — must be last.
  app.use(errorHandler);

  return { app, pinning, dispatcher, anchor, bitcoin, zk, payments };
}
