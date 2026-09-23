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
  run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}
export interface SqliteDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDb };

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

export interface UsageStore {
  apply(input: ApplyInput): ApplyResult;
  aggregateWeek(week: string): WeekAggregate;
  listReportWeeks(): string[];
  getReport(week: string): ReportRow | undefined;
  putReport(row: ReportRow): void;
  pruneNonces(olderThanMs: number): number;
  close(): void;
  readonly db: SqliteDb;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identity (
  anon_id TEXT PRIMARY KEY,
  pub_key TEXT NOT NULL,
  first_seen_week TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
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
`;

export function buildUsageStore(path: string): UsageStore {
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

  const selNonce = db.prepare("SELECT 1 AS one FROM nonce WHERE nonce = ?");
  const insNonce = db.prepare("INSERT INTO nonce(nonce, seen_at) VALUES (?, ?)");
  const selIdentity = db.prepare("SELECT anon_id, last_seq, first_seen_week FROM identity WHERE anon_id = ?");
  const insIdentity = db.prepare(
    "INSERT INTO identity(anon_id, pub_key, first_seen_week, last_seq, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  );
  const updIdentity = db.prepare("UPDATE identity SET last_seq = ?, updated_at = ? WHERE anon_id = ?");
  const insIdentityWeek = db.prepare("INSERT OR IGNORE INTO identity_week(week, anon_id) VALUES (?, ?)");
  const incCounter = db.prepare(
    "INSERT INTO weekly_counter(week, kind, count) VALUES (?,?,?) ON CONFLICT(week, kind) DO UPDATE SET count = count + excluded.count",
  );

  function apply(input: ApplyInput): ApplyResult {
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
      if (!id) {
        insIdentity.run(input.anonId, input.pubKey, input.week, input.seq, input.now, input.now);
      } else {
        updIdentity.run(input.seq, input.now, input.anonId);
      }
      insIdentityWeek.run(input.week, input.anonId);
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

  const aggCounters = db.prepare("SELECT kind, count FROM weekly_counter WHERE week = ?");
  const countIdentities = db.prepare("SELECT COUNT(*) AS n FROM identity_week WHERE week = ?");
  const countNew = db.prepare("SELECT COUNT(*) AS n FROM identity WHERE first_seen_week = ?");

  return {
    db,
    apply,

    aggregateWeek(week: string): WeekAggregate {
      const counters = {} as Counters;
      for (const k of COUNTER_KINDS) counters[k] = 0;
      for (const row of aggCounters.all(week) as { kind: string; count: number }[]) {
        if ((COUNTER_KINDS as readonly string[]).includes(row.kind)) counters[row.kind as keyof Counters] = row.count;
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

    listReportWeeks(): string[] {
      return (db.prepare("SELECT week FROM report ORDER BY week ASC").all() as { week: string }[]).map((r) => r.week);
    },

    getReport(week: string): ReportRow | undefined {
      const r = db.prepare("SELECT * FROM report WHERE week = ?").get(week) as Record<string, unknown> | undefined;
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

    putReport(row: ReportRow): void {
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

    pruneNonces(olderThanMs: number): number {
      return Number(db.prepare("DELETE FROM nonce WHERE seen_at < ?").run(olderThanMs).changes);
    },

    close(): void {
      db.close();
    },
  };
}
