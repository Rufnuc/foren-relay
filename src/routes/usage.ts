import { Router } from "express";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../config";
import type { AnchorService } from "../services/anchor";
import { finalizeWeeklyReport, type UsageService } from "../services/usage";
import { isoWeek } from "../services/usage/canonical";

/**
 * Anonymous usage tracking + public weekly reports.
 *
 *   POST /v1/usage             → submit a signed, counts-only usage delta
 *   GET  /v1/usage/reports     → list finalized weekly report labels
 *   GET  /v1/usage/reports/:week → one published weekly report + its commitment
 *
 * The relay never receives vault or incident data — only integer counters
 * signed by an anonymous key. See services/usage/verify.ts for the trust
 * boundary.
 */
export function usageRouter(deps: { cfg: Config; usage: UsageService; anchor: AnchorService }) {
  const r = Router();

  // Bearer-token check for the admin report endpoint (constant-time compare).
  function adminAuthorized(req: import("express").Request): boolean {
    const token = deps.cfg.USAGE_ADMIN_TOKEN;
    if (!token) return false; // endpoint disabled when unset
    const header = req.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const submitLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: deps.cfg.RATE_LIMIT_USAGE_PER_MIN,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate limited", code: "rate_limited" },
  });

  r.post("/", submitLimiter, async (req, res, next) => {
    try {
      const result = await deps.usage.submit(req.body);
      if (result.status === "rejected") {
        return res.status(400).json({ error: result.message ?? "rejected", code: result.code ?? "bad_request" });
      }
      // applied | duplicate | nonce_reused — all are acknowledged 200 so the
      // client stops retrying (duplicates are the exactly-once success case).
      return res.status(200).json({ ok: true, status: result.status });
    } catch (err) {
      next(err);
    }
  });

  // Finalise + anchor a weekly report, IN the relay (so the Solana key and the
  // database never leave it). Triggered by the scheduler (GitHub Action) or
  // manually. Auth: Authorization: Bearer <USAGE_ADMIN_TOKEN>. Body (optional):
  //   { "week": "2026-W39" }  explicit week, or
  //   { "current": true }     the current (in-progress) week, else the previous
  //                           complete week (the default for a weekly cron).
  r.post("/report/run", async (req, res, next) => {
    try {
      if (!deps.cfg.USAGE_ADMIN_TOKEN) {
        return res.status(404).json({ error: "not found", code: "not_found" });
      }
      if (!adminAuthorized(req)) {
        return res.status(401).json({ error: "unauthorized", code: "unauthorized" });
      }
      const body = (req.body ?? {}) as { week?: string; current?: boolean };
      const now = Date.now();
      const week =
        typeof body.week === "string" && /^\d{4}-W\d{2}$/.test(body.week)
          ? body.week
          : body.current
            ? isoWeek(now)
            : isoWeek(now - 7 * 24 * 60 * 60 * 1000); // previous complete week
      const result = await finalizeWeeklyReport(deps.usage, deps.anchor, week, undefined, now);
      return res.status(result.anchored ? 200 : 202).json(result);
    } catch (err) {
      next(err);
    }
  });

  r.get("/reports", async (_req, res, next) => {
    try {
      res.json({ weeks: await deps.usage.store.listReportWeeks() });
    } catch (err) {
      next(err);
    }
  });

  r.get("/reports/:week", async (req, res, next) => {
    try {
      const row = await deps.usage.store.getReport(req.params.week);
      if (!row) return res.status(404).json({ error: "no report for that week", code: "not_found" });
      // `report` is the exact published JSON (already-canonical string). The
      // public page re-hashes it and compares to `sha256` and the on-chain value.
      res.json({
        week: row.week,
        version: row.version,
        report: JSON.parse(row.json),
        reportJson: row.json,
        sha256: row.sha256,
        commitment: {
          cluster: row.chainCluster,
          tx: row.chainTx,
          explorer: row.chainExplorer,
          programId: row.chainProgram,
          recordPda: row.chainRecordPda,
        },
        createdAt: row.createdAt,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
