// SQLite persistence for usage tracking, on Node's built-in `node:sqlite`
// (Node >= 22.5 — no native dependency to compile). Stores ONLY: anonymous ids,
// their public keys, sequence numbers, replay nonces, weekly aggregate
// counters, and finalized weekly reports. No IP addresses, no accounts, no
// incident data.
//
// apply() is a single transaction implementing exactly-once semantics: a
// submission is applied iff its seq exceeds the identity's last_seq; anything at
// or below is acknowledged idempotently without re-counting. Nonces are
// recorded to reject replays within the freshness window.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { COUNTER_KINDS, type Counters } from "./verify";

// `node:sqlite` is a built-in (Node >= 22.5) so there is no native dependency to
// compile. This project's @types/node predates it (no types) and vitest's
// bundler cannot statically resolve it, so we load it via a runtime require()
// (a plain require in the CommonJS build) and type its small surface locally.
export interface SqliteStatement {
  run: (...params: unknown[]) => {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}
export interface SqliteDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDb;
};

export interface ApplyInput {
  anonId: string;
  pubKey: string;
  week: string;
  counters: Counters;
  seq: number;
  nonce: string;
  now: number;
}
export type ApplyResult =
  | { status: "applied" }
  | { status: "duplicate" } // seq already applied — idempotent ack
  | { status: "nonce_reused" };

export interface WeekAggregate {
  week: string;
  identities: number;
  newIdentities: number;
  returningIdentities: number;
  counters: Counters;
}

export interface ReportRow {
  week: string;
  version: number;
  json: string;
  sha256: string;
  chainTx: string | null;
  chainCluster: string | null;
  chainExplorer: string | null;
  chainProgram: string | null;
  chainRecordPda: string | null;
  createdAt: number;
}

/**
 * A hosted (zero-knowledge) vault backup. The relay stores only an opaque
 * locator, a write-authorisation commitment (a hash — never the secret), and the
 * IPFS CID of the E2E-encrypted blob. It cannot read the blob or link it to a
 * person.
 */
export interface BackupRow {
  locator: string;
  writeCommit: string; // SHA-256(writeSecret) — proves the code-holder authorised writes
  cid: string;
  size: number;
  createdAt: number;
  updatedAt: number;
}

/** Public redemption tally for one referral link (no redeemer identities). */
export interface ReferralRow {
  refId: string;
  redemptions: number;
  distinctRedeemers: number;
  firstRedeemedAt: number | null;
  lastRedeemedAt: number | null;
  createdAt: number;
}

export type RedeemResult =
  | { status: "recorded"; row: ReferralRow } // a new distinct redeemer
  | { status: "duplicate"; row: ReferralRow }; // this redeemer already counted

/** One anonymous identity's activity signals, for its own score + analytics. */
export interface ActivityRow {
  anonId: string;
  activityTotal: number;
  activeWeeks: number;
  lastActiveWeek: string | null;
  firstSeenWeek: string;
}

/** Aggregate referral totals across all links, for K-factor / reuse math. */
export interface ReferralTotals {
  links: number; // links that have ≥1 redemption
  redemptions: number; // total redemptions
  distinctRedeemers: number; // total distinct (refId, redeemer) pairs
}

// Async so the interface fits both the local synchronous node:sqlite backend
// and the remote (async) libSQL/Turso backend.
export interface UsageStore {
  apply(input: ApplyInput): Promise<ApplyResult>;
  aggregateWeek(week: string): Promise<WeekAggregate>;
  listReportWeeks(): Promise<string[]>;
  getReport(week: string): Promise<ReportRow | undefined>;
  putReport(row: ReportRow): Promise<void>;
  pruneNonces(olderThanMs: number): Promise<number>;
  getBackup(locator: string): Promise<BackupRow | undefined>;
  putBackup(row: BackupRow): Promise<void>;
  deleteBackup(locator: string): Promise<void>;
  // Referral + activity analytics.
  redeemReferral(
    refId: string,
    redeemerCommit: string,
    now: number,
  ): Promise<RedeemResult>;
  getReferral(refId: string): Promise<ReferralRow | undefined>;
  getActivity(anonId: string): Promise<ActivityRow | undefined>;
  listActivity(): Promise<ActivityRow[]>;
  referralTotals(): Promise<ReferralTotals>;
  retentionPoints(): Promise<
    { week: string; active: number; retained: number }[]
  >;
  close(): Promise<void>;
}

export const USAGE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS identity (
  anon_id TEXT PRIMARY KEY,
  pub_key TEXT NOT NULL,
  first_seen_week TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  activity_total INTEGER NOT NULL DEFAULT 0,
  active_weeks INTEGER NOT NULL DEFAULT 0,
  last_active_week TEXT
)`,
  // A shared referral LINK, keyed by an opaque, unguessable id the relay is
  // given (SHA-256 of the secret code the creator holds). The relay never sees
  // the code or the creator's identity — only redemption tallies.
  `CREATE TABLE IF NOT EXISTS referral (
  ref_id TEXT PRIMARY KEY,
  redemptions INTEGER NOT NULL DEFAULT 0,
  distinct_redeemers INTEGER NOT NULL DEFAULT 0,
  first_redeemed_at INTEGER,
  last_redeemed_at INTEGER,
  created_at INTEGER NOT NULL
)`,
  // Per-recipient dedupe: only the commitment SHA-256("refId|anonId") is kept,
  // so the relay can count DISTINCT redeemers without storing who they are.
  `CREATE TABLE IF NOT EXISTS referral_redeemer (
  ref_id TEXT NOT NULL,
  redeemer_commit TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (ref_id, redeemer_commit)
)`,
  `CREATE TABLE IF NOT EXISTS identity_week (
  week TEXT NOT NULL,
  anon_id TEXT NOT NULL,
  PRIMARY KEY (week, anon_id)
)`,
  `CREATE TABLE IF NOT EXISTS weekly_counter (
  week TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (week, kind)
)`,
  `CREATE TABLE IF NOT EXISTS nonce (
  nonce TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_nonce_seen ON nonce(seen_at)`,
  `CREATE TABLE IF NOT EXISTS report (
  week TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  chain_tx TEXT,
  chain_cluster TEXT,
  chain_explorer TEXT,
  chain_program TEXT,
  chain_record_pda TEXT,
  created_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS vault_backup (
  locator TEXT PRIMARY KEY,
  write_commit TEXT NOT NULL,
  cid TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identity (
  anon_id TEXT PRIMARY KEY,
  pub_key TEXT NOT NULL,
  first_seen_week TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  activity_total INTEGER NOT NULL DEFAULT 0,
  active_weeks INTEGER NOT NULL DEFAULT 0,
  last_active_week TEXT
);
CREATE TABLE IF NOT EXISTS referral (
  ref_id TEXT PRIMARY KEY,
  redemptions INTEGER NOT NULL DEFAULT 0,
  distinct_redeemers INTEGER NOT NULL DEFAULT 0,
  first_redeemed_at INTEGER,
  last_redeemed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS referral_redeemer (
  ref_id TEXT NOT NULL,
  redeemer_commit TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (ref_id, redeemer_commit)
);
CREATE TABLE IF NOT EXISTS identity_week (
  week TEXT NOT NULL,
  anon_id TEXT NOT NULL,
  PRIMARY KEY (week, anon_id)
);
CREATE TABLE IF NOT EXISTS weekly_counter (
  week TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (week, kind)
);
CREATE TABLE IF NOT EXISTS nonce (
  nonce TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonce_seen ON nonce(seen_at);
CREATE TABLE IF NOT EXISTS report (
  week TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  chain_tx TEXT,
  chain_cluster TEXT,
  chain_explorer TEXT,
  chain_program TEXT,
  chain_record_pda TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_backup (
  locator TEXT PRIMARY KEY,
  write_commit TEXT NOT NULL,
  cid TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// Local (synchronous) node:sqlite backend. Used for dev, tests (":memory:"),
// and any deployment with a persistent disk. The public methods are async to
// satisfy the shared UsageStore interface; the bodies run synchronously.
export function buildLocalUsageStore(path: string): UsageStore {
  // Ensure the parent directory exists for a file-backed DB (":memory:" skips).
  if (path !== ":memory:") {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* already exists / not creatable — DatabaseSync will surface a clear error */
    }
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // Migrate an identity table created before the activity columns existed. Each
  // ADD COLUMN throws if the column is already present — harmless, so ignore.
  for (const col of [
    "activity_total INTEGER NOT NULL DEFAULT 0",
    "active_weeks INTEGER NOT NULL DEFAULT 0",
    "last_active_week TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE identity ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }

  const selNonce = db.prepare("SELECT 1 AS one FROM nonce WHERE nonce = ?");
  const insNonce = db.prepare(
    "INSERT INTO nonce(nonce, seen_at) VALUES (?, ?)",
  );
  const selIdentity = db.prepare(
    "SELECT anon_id, last_seq, first_seen_week FROM identity WHERE anon_id = ?",
  );
  const insIdentity = db.prepare(
    `INSERT INTO identity(anon_id, pub_key, first_seen_week, last_seq, created_at, updated_at, activity_total, active_weeks, last_active_week)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const updIdentity = db.prepare(
    `UPDATE identity SET last_seq = ?, updated_at = ?, activity_total = activity_total + ?,
       active_weeks = active_weeks + ?, last_active_week = ? WHERE anon_id = ?`,
  );
  const insIdentityWeek = db.prepare(
    "INSERT OR IGNORE INTO identity_week(week, anon_id) VALUES (?, ?)",
  );
  const incCounter = db.prepare(
    "INSERT INTO weekly_counter(week, kind, count) VALUES (?,?,?) ON CONFLICT(week, kind) DO UPDATE SET count = count + excluded.count",
  );

  function applySync(input: ApplyInput): ApplyResult {
    // node:sqlite has no transaction() helper — drive it explicitly so the
    // nonce/seq checks and the counter writes commit atomically.
    db.exec("BEGIN IMMEDIATE");
    try {
      if (selNonce.get(input.nonce)) {
        db.exec("COMMIT");
        return { status: "nonce_reused" };
      }
      const id = selIdentity.get(input.anonId) as
        | { anon_id: string; last_seq: number; first_seen_week: string }
        | undefined;

      if (id && input.seq <= id.last_seq) {
        insNonce.run(input.nonce, input.now);
        db.exec("COMMIT");
        return { status: "duplicate" };
      }

      insNonce.run(input.nonce, input.now);
      // Per-identity activity: total actions this submission, and whether this is
      // a new active week for the identity (drives the frequency signal).
      const totalDelta = COUNTER_KINDS.reduce(
        (a, k) => a + (input.counters[k] ?? 0),
        0,
      );
      const weekIsNew =
        Number(insIdentityWeek.run(input.week, input.anonId).changes) > 0
          ? 1
          : 0;
      if (!id) {
        insIdentity.run(
          input.anonId,
          input.pubKey,
          input.week,
          input.seq,
          input.now,
          input.now,
          totalDelta,
          1,
          input.week,
        );
      } else {
        updIdentity.run(
          input.seq,
          input.now,
          totalDelta,
          weekIsNew,
          input.week,
          input.anonId,
        );
      }
      for (const kind of COUNTER_KINDS) {
        const delta = input.counters[kind] ?? 0;
        if (delta > 0) incCounter.run(input.week, kind, delta);
      }
      db.exec("COMMIT");
      return { status: "applied" };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const aggCounters = db.prepare(
    "SELECT kind, count FROM weekly_counter WHERE week = ?",
  );
  const countIdentities = db.prepare(
    "SELECT COUNT(*) AS n FROM identity_week WHERE week = ?",
  );
  const countNew = db.prepare(
    "SELECT COUNT(*) AS n FROM identity WHERE first_seen_week = ?",
  );

  const selReferral = db.prepare("SELECT * FROM referral WHERE ref_id = ?");
  const insRedeemer = db.prepare(
    "INSERT OR IGNORE INTO referral_redeemer(ref_id, redeemer_commit, redeemed_at) VALUES (?,?,?)",
  );
  // `redemptions` counts EVERY authenticated open (repeats included);
  // `distinct_redeemers` only counts unique recipients (distinctInc = 1 for a
  // new commit, 0 for a repeat). So "reuse" is visible two ways: many distinct
  // people, and/or the same link opened repeatedly.
  const upsertReferral = db.prepare(
    `INSERT INTO referral(ref_id, redemptions, distinct_redeemers, first_redeemed_at, last_redeemed_at, created_at)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(ref_id) DO UPDATE SET
       redemptions = redemptions + 1,
       distinct_redeemers = distinct_redeemers + ?,
       first_redeemed_at = COALESCE(first_redeemed_at, excluded.first_redeemed_at),
       last_redeemed_at = excluded.last_redeemed_at`,
  );
  const selActivity = db.prepare(
    "SELECT anon_id, activity_total, active_weeks, last_active_week, first_seen_week FROM identity WHERE anon_id = ?",
  );

  function referralRow(
    r: Record<string, unknown> | undefined,
  ): ReferralRow | undefined {
    if (!r) return undefined;
    return {
      refId: r.ref_id as string,
      redemptions: r.redemptions as number,
      distinctRedeemers: r.distinct_redeemers as number,
      firstRedeemedAt: (r.first_redeemed_at as number) ?? null,
      lastRedeemedAt: (r.last_redeemed_at as number) ?? null,
      createdAt: r.created_at as number,
    };
  }

  return {
    async apply(input: ApplyInput): Promise<ApplyResult> {
      return applySync(input);
    },

    async aggregateWeek(week: string): Promise<WeekAggregate> {
      const counters = {} as Counters;
      for (const k of COUNTER_KINDS) counters[k] = 0;
      for (const row of aggCounters.all(week) as {
        kind: string;
        count: number;
      }[]) {
        if ((COUNTER_KINDS as readonly string[]).includes(row.kind))
          counters[row.kind as keyof Counters] = row.count;
      }
      const identities = (countIdentities.get(week) as { n: number }).n;
      const newIdentities = (countNew.get(week) as { n: number }).n;
      return {
        week,
        identities,
        newIdentities,
        returningIdentities: Math.max(0, identities - newIdentities),
        counters,
      };
    },

    async listReportWeeks(): Promise<string[]> {
      return (
        db.prepare("SELECT week FROM report ORDER BY week ASC").all() as {
          week: string;
        }[]
      ).map((r) => r.week);
    },

    async getReport(week: string): Promise<ReportRow | undefined> {
      const r = db.prepare("SELECT * FROM report WHERE week = ?").get(week) as
        | Record<string, unknown>
        | undefined;
      if (!r) return undefined;
      return {
        week: r.week as string,
        version: r.version as number,
        json: r.json as string,
        sha256: r.sha256 as string,
        chainTx: (r.chain_tx as string) ?? null,
        chainCluster: (r.chain_cluster as string) ?? null,
        chainExplorer: (r.chain_explorer as string) ?? null,
        chainProgram: (r.chain_program as string) ?? null,
        chainRecordPda: (r.chain_record_pda as string) ?? null,
        createdAt: r.created_at as number,
      };
    },

    async putReport(row: ReportRow): Promise<void> {
      db.prepare(
        `INSERT INTO report(week, version, json, sha256, chain_tx, chain_cluster, chain_explorer, chain_program, chain_record_pda, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(week) DO UPDATE SET
           version=excluded.version, json=excluded.json, sha256=excluded.sha256,
           chain_tx=excluded.chain_tx, chain_cluster=excluded.chain_cluster, chain_explorer=excluded.chain_explorer,
           chain_program=excluded.chain_program, chain_record_pda=excluded.chain_record_pda, created_at=excluded.created_at`,
      ).run(
        row.week,
        row.version,
        row.json,
        row.sha256,
        row.chainTx,
        row.chainCluster,
        row.chainExplorer,
        row.chainProgram,
        row.chainRecordPda,
        row.createdAt,
      );
    },

    async pruneNonces(olderThanMs: number): Promise<number> {
      return Number(
        db.prepare("DELETE FROM nonce WHERE seen_at < ?").run(olderThanMs)
          .changes,
      );
    },

    async getBackup(locator: string): Promise<BackupRow | undefined> {
      const r = db
        .prepare("SELECT * FROM vault_backup WHERE locator = ?")
        .get(locator) as Record<string, unknown> | undefined;
      if (!r) return undefined;
      return {
        locator: r.locator as string,
        writeCommit: r.write_commit as string,
        cid: r.cid as string,
        size: r.size as number,
        createdAt: r.created_at as number,
        updatedAt: r.updated_at as number,
      };
    },

    async putBackup(row: BackupRow): Promise<void> {
      db.prepare(
        `INSERT INTO vault_backup(locator, write_commit, cid, size, created_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(locator) DO UPDATE SET
           write_commit=excluded.write_commit, cid=excluded.cid, size=excluded.size, updated_at=excluded.updated_at`,
      ).run(
        row.locator,
        row.writeCommit,
        row.cid,
        row.size,
        row.createdAt,
        row.updatedAt,
      );
    },

    async deleteBackup(locator: string): Promise<void> {
      db.prepare("DELETE FROM vault_backup WHERE locator = ?").run(locator);
    },

    async redeemReferral(
      refId: string,
      commit: string,
      now: number,
    ): Promise<RedeemResult> {
      db.exec("BEGIN IMMEDIATE");
      try {
        const inserted =
          Number(insRedeemer.run(refId, commit, now).changes) > 0;
        const distinctInc = inserted ? 1 : 0;
        // Args: (ref_id, distinct_redeemers[VALUES], first, last, created, distinctInc[UPDATE]).
        upsertReferral.run(refId, distinctInc, now, now, now, distinctInc);
        const row = referralRow(
          selReferral.get(refId) as Record<string, unknown> | undefined,
        )!;
        db.exec("COMMIT");
        return { status: inserted ? "recorded" : "duplicate", row };
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    async getReferral(refId: string): Promise<ReferralRow | undefined> {
      return referralRow(
        selReferral.get(refId) as Record<string, unknown> | undefined,
      );
    },

    async getActivity(anonId: string): Promise<ActivityRow | undefined> {
      const r = selActivity.get(anonId) as Record<string, unknown> | undefined;
      if (!r) return undefined;
      return {
        anonId: r.anon_id as string,
        activityTotal: (r.activity_total as number) ?? 0,
        activeWeeks: (r.active_weeks as number) ?? 0,
        lastActiveWeek: (r.last_active_week as string) ?? null,
        firstSeenWeek: r.first_seen_week as string,
      };
    },

    async listActivity(): Promise<ActivityRow[]> {
      const rows = db
        .prepare(
          "SELECT anon_id, activity_total, active_weeks, last_active_week, first_seen_week FROM identity",
        )
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        anonId: r.anon_id as string,
        activityTotal: (r.activity_total as number) ?? 0,
        activeWeeks: (r.active_weeks as number) ?? 0,
        lastActiveWeek: (r.last_active_week as string) ?? null,
        firstSeenWeek: r.first_seen_week as string,
      }));
    },

    async referralTotals(): Promise<ReferralTotals> {
      const r = db
        .prepare(
          "SELECT COUNT(*) AS links, COALESCE(SUM(redemptions),0) AS redemptions, COALESCE(SUM(distinct_redeemers),0) AS distinct_redeemers FROM referral",
        )
        .get() as {
        links: number;
        redemptions: number;
        distinct_redeemers: number;
      };
      return {
        links: r.links,
        redemptions: r.redemptions,
        distinctRedeemers: r.distinct_redeemers,
      };
    },

    async retentionPoints(): Promise<
      { week: string; active: number; retained: number }[]
    > {
      const weeks = (
        db
          .prepare("SELECT DISTINCT week FROM identity_week ORDER BY week ASC")
          .all() as {
          week: string;
        }[]
      ).map((r) => r.week);
      const activeIn = db.prepare(
        "SELECT anon_id FROM identity_week WHERE week = ?",
      );
      const out: { week: string; active: number; retained: number }[] = [];
      for (let i = 0; i < weeks.length - 1; i++) {
        const cur = new Set(
          (activeIn.all(weeks[i]) as { anon_id: string }[]).map(
            (r) => r.anon_id,
          ),
        );
        const nxt = new Set(
          (activeIn.all(weeks[i + 1]) as { anon_id: string }[]).map(
            (r) => r.anon_id,
          ),
        );
        let retained = 0;
        for (const a of cur) if (nxt.has(a)) retained++;
        out.push({ week: weeks[i], active: cur.size, retained });
      }
      return out;
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
