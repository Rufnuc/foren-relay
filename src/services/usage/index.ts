// Usage service: assembles the store + verification into the surface the route
// and the weekly-report script use. Injectable (buildUsageService) to match the
// relay's DI convention; tests pass an in-memory database path (":memory:").

import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { AnchorService } from "../anchor";
import {
  buildLocalUsageStore,
  type UsageStore,
  type WeekAggregate,
} from "./store";
import { buildLibsqlUsageStore } from "./store_libsql";
import { verifySubmission, type VerifyResult } from "./verify";
import { verifySignedEnvelope, redeemerCommit } from "./signed";
import {
  activityScore as computeActivityScore,
  describe,
  kFactor,
  percentileRank,
  retentionCurve,
  reuseRate,
  type Distribution,
} from "./analytics";
import { canonicalize, isoWeek, isoWeekRange } from "./canonical";

/** Whole weeks between two ISO week labels (>= 0), by their Monday start times. */
function weeksBetween(fromWeek: string, toWeek: string): number {
  try {
    const a = isoWeekRange(fromWeek).startMs;
    const b = isoWeekRange(toWeek).startMs;
    return Math.max(0, Math.floor((b - a) / (7 * 86400000)));
  } catch {
    return 0;
  }
}

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

export function buildWeeklyReport(
  agg: WeekAggregate,
  version = 1,
): BuiltReport {
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

export interface FinalizeResult {
  week: string;
  version: number;
  sha256: string;
  metrics: WeeklyReport["metrics"];
  anchored: boolean;
  chainTx: string | null;
  chainExplorer: string | null;
  error?: string;
}

/**
 * Finalise a week: build the deterministic report (bumping the version if one
 * already exists — a versioned correction, never a silent edit), anchor ONLY
 * its SHA-256 on-chain, and store it. Shared by the CLI script and the admin
 * endpoint so both behave identically. Anchoring failure is non-fatal: the
 * report is still stored (commitment null) so it can be re-anchored later.
 */
export async function finalizeWeeklyReport(
  usage: UsageService,
  anchor: AnchorService,
  week: string,
  logger?: Logger,
  now: number = Date.now(),
): Promise<FinalizeResult> {
  const existing = await usage.store.getReport(week);
  const version = existing ? existing.version + 1 : 1;
  const built = await usage.buildReportForWeek(week, version);

  let anchored = false;
  let chainTx: string | null = null;
  let chainExplorer: string | null = null;
  let chainCluster: string | null = null;
  let chainProgram: string | null = null;
  let chainRecordPda: string | null = null;
  let error: string | undefined;
  try {
    const res = await anchor.anchorRoot(built.sha256);
    anchored = true;
    chainTx = res.signature;
    chainExplorer = res.explorer;
    chainCluster = res.cluster;
    chainProgram = res.programId;
    chainRecordPda = res.recordPda;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger?.error(
      { err, week },
      "usage: anchoring failed — storing report without commitment",
    );
  }

  await usage.store.putReport({
    week,
    version,
    json: built.json,
    sha256: built.sha256,
    chainTx,
    chainCluster,
    chainExplorer,
    chainProgram,
    chainRecordPda,
    createdAt: now,
  });

  return {
    week,
    version,
    sha256: built.sha256,
    metrics: built.report.metrics,
    anchored,
    chainTx,
    chainExplorer,
    error,
  };
}

/** Public referral stats (no redeemer identities — safe to hand to the creator). */
export interface ReferralPublic {
  refId: string;
  redemptions: number;
  distinctRedeemers: number;
  reused: boolean; // more than one distinct person used the link
  firstRedeemedAt: number | null;
  lastRedeemedAt: number | null;
}

export interface ActivityScoreResult {
  score: number; // 0..100
  percentile: number; // 0..1 — share of identities at or below this activity
  activeWeeks: number;
  weeksSinceActive: number;
  totalActions: number;
  population: number;
}

export interface AnalyticsReport {
  generatedAt: number;
  week: string;
  population: number; // total users (installs ∪ active identities)
  activeUsers: number; // identities that have performed ≥1 action
  activity: Distribution; // over active users only
  scores: Distribution; // over active users only

  referrals: {
    links: number;
    redemptions: number;
    distinctRedeemers: number;
    kFactor: number;
    reuseRate: number;
  };
  retention: { week: string; active: number; retained: number; rate: number }[];
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

export interface UsageService {
  readonly store: UsageStore;
  submit(
    body: unknown,
    now?: number,
  ): Promise<{ status: string; code?: string; message?: string }>;
  register(
    body: unknown,
    now?: number,
  ): Promise<ServiceResult<{ status: string }>>;
  redeemReferral(
    body: unknown,
    now?: number,
  ): Promise<ServiceResult<{ status: string; referral: ReferralPublic }>>;
  referralStats(refId: string): Promise<ReferralPublic | undefined>;
  activityScore(
    body: unknown,
    now?: number,
  ): Promise<ServiceResult<ActivityScoreResult>>;
  buildAnalytics(now?: number): Promise<AnalyticsReport>;
  buildReportForWeek(week: string, version?: number): Promise<BuiltReport>;
  currentWeek(now?: number): string;
  close(): Promise<void>;
}

const REF_ID = /^[A-Za-z0-9_-]{16,128}$/;

function toPublic(row: {
  refId: string;
  redemptions: number;
  distinctRedeemers: number;
  firstRedeemedAt: number | null;
  lastRedeemedAt: number | null;
}): ReferralPublic {
  return {
    refId: row.refId,
    redemptions: row.redemptions,
    distinctRedeemers: row.distinctRedeemers,
    reused: row.distinctRedeemers > 1,
    firstRedeemedAt: row.firstRedeemedAt,
    lastRedeemedAt: row.lastRedeemedAt,
  };
}

export function buildUsageService(
  cfg: UsageServiceConfig,
  logger?: Logger,
): UsageService {
  const store: UsageStore = cfg.libsqlUrl
    ? buildLibsqlUsageStore(cfg.libsqlUrl, cfg.libsqlAuthToken)
    : buildLocalUsageStore(cfg.dbPath);
  if (cfg.libsqlUrl) logger?.info("usage: using durable libSQL backend");

  return {
    store,

    async submit(body: unknown, now = Date.now()) {
      const res: VerifyResult = await verifySubmission(body, {
        now,
        maxSkewMs: cfg.maxSkewMs,
      });
      if (!res.ok)
        return { status: "rejected", code: res.code, message: res.message };

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

    async register(body: unknown, now = Date.now()) {
      // A signed proof of an anonymous identity, no counters. Records the install
      // so a device that has finished setup but not acted yet still counts as a
      // user. Idempotent, and kept out of the activity/report tables.
      const res = await verifySignedEnvelope<Record<string, never>>(body, [], {
        now,
        maxSkewMs: cfg.maxSkewMs,
      });
      if (!res.ok)
        return { ok: false as const, code: res.code, message: res.message };
      await store.registerIdentity(res.anonId, "", isoWeek(now), now);
      return { ok: true as const, value: { status: "registered" } };
    },

    async redeemReferral(body: unknown, now = Date.now()) {
      const res = await verifySignedEnvelope<{ refId: string }>(
        body,
        ["refId"],
        {
          now,
          maxSkewMs: cfg.maxSkewMs,
        },
      );
      if (!res.ok)
        return { ok: false as const, code: res.code, message: res.message };
      const refId = res.fields.refId;
      if (!REF_ID.test(refId)) {
        return {
          ok: false as const,
          code: "bad_ref",
          message: "refId is malformed",
        };
      }
      // The relay computes the dedupe commitment itself from the (verified)
      // anonId — the client never sends who redeemed, and the creator's identity
      // is never part of this at all.
      const commit = redeemerCommit(refId, res.anonId);
      const out = await store.redeemReferral(refId, commit, now);
      try {
        await store.pruneNonces(now - cfg.nonceRetentionMs);
      } catch (err) {
        logger?.warn({ err }, "referral: nonce prune failed");
      }
      return {
        ok: true as const,
        value: { status: out.status, referral: toPublic(out.row) },
      };
    },

    async referralStats(refId: string): Promise<ReferralPublic | undefined> {
      if (!REF_ID.test(refId)) return undefined;
      const row = await store.getReferral(refId);
      return row ? toPublic(row) : undefined;
    },

    async activityScore(body: unknown, now = Date.now()) {
      const res = await verifySignedEnvelope<Record<string, never>>(body, [], {
        now,
        maxSkewMs: cfg.maxSkewMs,
      });
      if (!res.ok)
        return { ok: false as const, code: res.code, message: res.message };
      const act = await store.getActivity(res.anonId);
      const all = await store.listActivity();
      const population = all.length;
      if (!act) {
        // Known key, but no usage recorded yet (tracking may be off): score 0.
        return {
          ok: true as const,
          value: {
            score: 0,
            percentile: 0,
            activeWeeks: 0,
            weeksSinceActive: 0,
            totalActions: 0,
            population,
          },
        };
      }
      const curWeek = isoWeek(now);
      const weeksSince = act.lastActiveWeek
        ? weeksBetween(act.lastActiveWeek, curWeek)
        : 0;
      const score = computeActivityScore({
        volume: act.activityTotal,
        activeWeeks: act.activeWeeks,
        weeksSince,
      });
      const percentile = percentileRank(
        all.map((a) => a.activityTotal),
        act.activityTotal,
      );
      return {
        ok: true as const,
        value: {
          score,
          percentile: Math.round(percentile * 10000) / 10000,
          activeWeeks: act.activeWeeks,
          weeksSinceActive: weeksSince,
          totalActions: act.activityTotal,
          population,
        },
      };
    },

    async buildAnalytics(now = Date.now()): Promise<AnalyticsReport> {
      const acts = await store.listActivity();
      const curWeek = isoWeek(now);
      const totals = acts.map((a) => a.activityTotal);
      const scores = acts.map((a) =>
        computeActivityScore({
          volume: a.activityTotal,
          activeWeeks: a.activeWeeks,
          weeksSince: a.lastActiveWeek
            ? weeksBetween(a.lastActiveWeek, curWeek)
            : 0,
        }),
      );
      const rt = await store.referralTotals();
      const retention = retentionCurve(await store.retentionPoints());
      const totalUsers = await store.totalUsers();
      return {
        generatedAt: now,
        week: curWeek,
        population: totalUsers, // installs ∪ active identities
        activeUsers: acts.length, // performed ≥1 action
        activity: describe(totals), // distributions over active users only
        scores: describe(scores),
        referrals: {
          links: rt.links,
          redemptions: rt.redemptions,
          distinctRedeemers: rt.distinctRedeemers,
          kFactor: kFactor(rt.distinctRedeemers, totalUsers),
          reuseRate: reuseRate(rt.redemptions, rt.links),
        },
        retention,
      };
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
