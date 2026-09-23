import { Router } from "express";
import rateLimit from "express-rate-limit";
import type { Config } from "../config";
import type { UsageService } from "../services/usage";

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
export function usageRouter(deps: { cfg: Config; usage: UsageService }) {
  const r = Router();

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

  r.get("/reports", (_req, res) => {
    res.json({ weeks: deps.usage.store.listReportWeeks() });
  });

  r.get("/reports/:week", (req, res) => {
    const row = deps.usage.store.getReport(req.params.week);
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
  });

  return r;
}
