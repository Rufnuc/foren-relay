import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import type { Config } from "../config";
import type { AnchorService } from "../services/anchor";
import type { BitcoinAnchorService } from "../services/bitcoin";
import { badRequest } from "../util/errors";

// 64-char lowercase hex SHA-256 Merkle root.
const RootHex = z.string().regex(/^[0-9a-f]{64}$/, "root must be a 64-char hex hash");
// Optional nonce (decimal u64 string) lets the caller reuse a prior nonce for an
// idempotent re-anchor; omitted → the relay mints a random, unlinkable one.
const AnchorSchema = z.object({
  root: RootHex,
  nonce: z.string().regex(/^\d{1,20}$/, "nonce must be a u64 decimal string").optional(),
});
const BitcoinVerifySchema = z.object({ root: RootHex, ots: z.string().min(1).max(64 * 1024) });

/**
 * POST /v1/anchor/solana
 *
 * Anchors a Merkle root on-chain as an SPL Memo and returns the transaction
 * signature. The relay holds the signing key — it is never exposed to the
 * client. Idempotency is intentionally left to the caller (re-anchoring is
 * cheap and produces a fresh, independently-valid commitment).
 */
export function anchorRouter(deps: {
  cfg: Config;
  anchor: AnchorService;
  bitcoin: BitcoinAnchorService;
}) {
  const r = Router();
  r.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: deps.cfg.RATE_LIMIT_ANCHOR_PER_MIN,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "rate limited", code: "rate_limited" },
    }),
  );

  r.get("/solana", (_req, res) => {
    res.json({ cluster: deps.anchor.cluster, signer: deps.anchor.publicKey, rpc: deps.anchor.rpcUrl });
  });

  r.post("/solana", async (req, res, next) => {
    try {
      const parsed = AnchorSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const result = await deps.anchor.anchorRoot(parsed.data.root, parsed.data.nonce);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Bitcoin via OpenTimestamps. POST /bitcoin stamps the root (instant,
  // "pending"); POST /bitcoin/verify upgrades + checks for a confirmation.
  r.post("/bitcoin", async (req, res, next) => {
    try {
      const parsed = AnchorSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      res.json(await deps.bitcoin.stamp(parsed.data.root));
    } catch (err) {
      next(err);
    }
  });

  r.post("/bitcoin/verify", async (req, res, next) => {
    try {
      const parsed = BitcoinVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      res.json(await deps.bitcoin.verify(parsed.data.root, parsed.data.ots));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
