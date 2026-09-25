import { Router } from "express";
import rateLimit from "express-rate-limit";
import type { Config } from "../config";
import type { UsageService } from "../services/usage";

/**
 * "Help a friend" referral analytics + per-user activity score.
 *
 *   POST /v1/referral/redeem   → a signed redemption of a shared link
 *   GET  /v1/referral/:refId   → public reuse stats for a link (creator polls this)
 *   POST /v1/activity/score    → a signed request for the caller's OWN activity score
 *
 * PRIVACY: the relay is given only an opaque `refId` (a hash of the secret code
 * the creator holds) and, for redemptions, a signed proof from the RECIPIENT.
 * It never learns the code, never learns who created a link, and stores only a
 * per-recipient commitment (SHA-256("refId|anonId")) so it can count distinct
 * redeemers without knowing who they are.
 */
export function referralRouter(deps: { cfg: Config; usage: UsageService }) {
  const r = Router();

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: deps.cfg.RATE_LIMIT_REFERRAL_PER_MIN,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate limited", code: "rate_limited" },
  });

  r.post("/redeem", limiter, async (req, res, next) => {
    try {
      const out = await deps.usage.redeemReferral(req.body);
      if (!out.ok)
        return res.status(400).json({ error: out.message, code: out.code });
      // recorded | duplicate — both acknowledged 200 (duplicate = idempotent).
      return res
        .status(200)
        .json({
          ok: true,
          status: out.value.status,
          referral: out.value.referral,
        });
    } catch (err) {
      next(err);
    }
  });

  r.get("/:refId", limiter, async (req, res, next) => {
    try {
      const stats = await deps.usage.referralStats(req.params.refId);
      if (!stats)
        return res
          .status(404)
          .json({ error: "no such link", code: "not_found" });
      return res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  return r;
}

/** POST /v1/activity/score — a signed request for the caller's own score. */
export function activityRouter(deps: { cfg: Config; usage: UsageService }) {
  const r = Router();

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: deps.cfg.RATE_LIMIT_REFERRAL_PER_MIN,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate limited", code: "rate_limited" },
  });

  r.post("/score", limiter, async (req, res, next) => {
    try {
      const out = await deps.usage.activityScore(req.body);
      if (!out.ok)
        return res.status(400).json({ error: out.message, code: out.code });
      return res.json(out.value);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
