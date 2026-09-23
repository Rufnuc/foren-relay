// Usage service: assembles the store + verification into the surface the route
// and the weekly-report script use. Injectable (buildUsageService) to match the
// relay's DI convention; tests pass an in-memory database path (":memory:").

import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { buildLocalUsageStore, type UsageStore, type WeekAggregate } from "./store";
import { buildLibsqlUsageStore } from "./store_libsql";
import { verifySubmission, type VerifyResult } from "./verify";
import { canonicalize, isoWeek, isoWeekRange } from "./canonical";

export interface UsageServiceConfig {
  dbPath: string;
  maxSkewMs: number;
  nonceRetentionMs: number;
  // When set, use the durable libSQL/Turso backend instead of local SQLite.
  libsqlUrl?: string;
  libsqlAuthToken?: string;
}

/** The public, deterministic weekly report object. */
export interface WeeklyReport {
  v: 1;
  kind: "foren-weekly-usage";
  week: string;
  period: { start: string; end: string };
  version: number;
  metrics: {
    anonymous_identities: number;
    new_anonymous_identities: number;
    returning_anonymous_identities: number;
    records_created: number;
    records_updated: number;
    evidence_added: number;
    verification_operations: number;
    exports: number;
  };
}

export interface BuiltReport {
  report: WeeklyReport;
  json: string; // canonical serialization (this is what gets hashed + published)
  sha256: string; // hex
}

function ymdUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildWeeklyReport(agg: WeekAggregate, version = 1): BuiltReport {
  const range = isoWeekRange(agg.week);
  const report: WeeklyReport = {
    v: 1,
    kind: "foren-weekly-usage",
    week: agg.week,
    period: { start: ymdUTC(range.startMs), end: ymdUTC(range.endMs) },
    version,
    metrics: {
      anonymous_identities: agg.identities,
      new_anonymous_identities: agg.newIdentities,
      returning_anonymous_identities: agg.returningIdentities,
      records_created: agg.counters.record_created,
      records_updated: agg.counters.record_updated,
      evidence_added: agg.counters.evidence_added,
      verification_operations: agg.counters.verification_performed,
      exports: agg.counters.export_performed,
    },
  };
  const json = canonicalize(report);
  const sha256 = createHash("sha256").update(json, "utf8").digest("hex");
  return { report, json, sha256 };
}

export interface UsageService {
  readonly store: UsageStore;
  submit(body: unknown, now?: number): Promise<{ status: string; code?: string; message?: string }>;
  buildReportForWeek(week: string, version?: number): Promise<BuiltReport>;
  currentWeek(now?: number): string;
  close(): Promise<void>;
}

export function buildUsageService(cfg: UsageServiceConfig, logger?: Logger): UsageService {
  const store: UsageStore = cfg.libsqlUrl
    ? buildLibsqlUsageStore(cfg.libsqlUrl, cfg.libsqlAuthToken)
    : buildLocalUsageStore(cfg.dbPath);
  if (cfg.libsqlUrl) logger?.info("usage: using durable libSQL backend");

  return {
    store,

    async submit(body: unknown, now = Date.now()) {
      const res: VerifyResult = await verifySubmission(body, { now, maxSkewMs: cfg.maxSkewMs });
      if (!res.ok) return { status: "rejected", code: res.code, message: res.message };

      const week = isoWeek(now);
      const applied = await store.apply({
        anonId: res.sub.anonId,
        pubKey: res.sub.pubKey,
        week,
        counters: res.sub.counters,
        seq: res.sub.seq,
        nonce: res.sub.nonce,
        now,
      });

      // Opportunistic housekeeping: drop nonces older than the freshness window
      // (a replay that old is already rejected by the timestamp check).
      try {
        await store.pruneNonces(now - cfg.nonceRetentionMs);
      } catch (err) {
        logger?.warn({ err }, "usage: nonce prune failed");
      }
      return { status: applied.status };
    },

    async buildReportForWeek(week: string, version = 1): Promise<BuiltReport> {
      return buildWeeklyReport(await store.aggregateWeek(week), version);
    },

    currentWeek(now = Date.now()): string {
      return isoWeek(now);
    },

    close(): Promise<void> {
      return store.close();
    },
  };
}
