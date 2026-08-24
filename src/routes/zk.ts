import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import type { Config } from "../config";
import type { ZkService } from "../services/zk";
import { badRequest } from "../util/errors";

const Hex = (bytes: number) =>
  z.string().regex(new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`), `expected ${bytes}-byte hex`);
const Fr = z.string().regex(/^(0x[0-9a-fA-F]+|\d+)$/, "expected a decimal or 0x-hex field element");

const VerifySchema = z.object({
  proof_a: Hex(64),
  proof_b: Hex(128),
  proof_c: Hex(64),
  public_inputs: z.array(Fr).min(1).max(16),
});

/**
 * ZK verification. A client proves selective-disclosure statements about
 * anchored evidence (slot range + location/nullifier commitments) WITHOUT
 * revealing the underlying evidence; the relay submits the proof to the
 * on-chain `zk_verifier` for a trustless pairing check.
 *
 *   GET  /v1/zk           → program + verifying-key account + input schema
 *   POST /v1/zk/verify    → { verified, signature? }
 */
export function zkRouter(deps: { cfg: Config; zk: ZkService }) {
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

  r.get("/", (_req, res) => {
    res.json({
      cluster: deps.cfg.SOLANA_CLUSTER,
      programId: deps.zk.programId,
      vkAccount: deps.zk.vkAccount,
      circuit: "evidence_zk",
      publicInputs: deps.zk.publicInputSchema,
    });
  });

  r.post("/verify", async (req, res, next) => {
    try {
      const parsed = VerifySchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const result = await deps.zk.verifyOnChain(parsed.data);
      res.status(result.verified ? 200 : 422).json(result);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
