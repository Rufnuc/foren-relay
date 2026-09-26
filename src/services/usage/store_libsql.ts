// Durable, free-tier-friendly backend on libSQL / Turso (SQLite over HTTP).
// Same schema and SQL dialect as the local node:sqlite store, so behaviour is
// identical; only the driver differs. Selected when a libSQL URL is configured
// (see index.ts); otherwise the local store is used. The remote client is
// pure-JS (fetch), so there is nothing native to compile on the host.

import { createClient, type Client } from "@libsql/client";
import { COUNTER_KINDS, type Counters } from "./verify";
import {
  USAGE_SCHEMA_STATEMENTS,
  type ActivityRow,
  type ApplyInput,
  type ApplyResult,
  type BackupRow,
  type RedeemResult,
  type ReferralRow,
  type ReferralTotals,
  type ReportRow,
  type UsageStore,
  type WeekAggregate,
} from "./store";

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string | null => (v == null ? null : String(v));

export function buildLibsqlUsageStore(
  url: string,
  authToken?: string,
): UsageStore {
  const client: Client = createClient({ url, authToken });

  // Create the schema once, lazily, so the builder can stay synchronous.
  let ensured: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    if (!ensured) {
      ensured = (async () => {
        for (const sql of USAGE_SCHEMA_STATEMENTS) await client.execute(sql);
        // Migrate a pre-existing identity table to the activity columns. Each
        // ADD COLUMN errors if already present — harmless, so swallow it.
        for (const col of [
          "activity_total INTEGER NOT NULL DEFAULT 0",
          "active_weeks INTEGER NOT NULL DEFAULT 0",
          "last_active_week TEXT",
        ]) {
          try {
            await client.execute(`ALTER TABLE identity ADD COLUMN ${col}`);
          } catch {
            /* column already exists */
          }
        }
      })();
    }
    return ensured;
  };

  return {
    async apply(input: ApplyInput): Promise<ApplyResult> {
      await ensure();
      const tx = await client.transaction("write");
      try {
        const nonceHit = await tx.execute({
          sql: "SELECT 1 FROM nonce WHERE nonce = ?",
          args: [input.nonce],
        });
        if (nonceHit.rows.length) {
          await tx.commit();
          return { status: "nonce_reused" };
        }
        const idRes = await tx.execute({
          sql: "SELECT anon_id, last_seq, first_seen_week FROM identity WHERE anon_id = ?",
          args: [input.anonId],
        });
        const id = idRes.rows[0] as unknown as
          | { last_seq: unknown }
          | undefined;

        if (id && input.seq <= num(id.last_seq)) {
          await tx.execute({
            sql: "INSERT INTO nonce(nonce, seen_at) VALUES (?, ?)",
            args: [input.nonce, input.now],
          });
          await tx.commit();
          return { status: "duplicate" };
        }

        await tx.execute({
          sql: "INSERT INTO nonce(nonce, seen_at) VALUES (?, ?)",
          args: [input.nonce, input.now],
        });
        // Per-identity activity: total actions + whether this is a new week.
        const totalDelta = COUNTER_KINDS.reduce(
          (a, k) => a + (input.counters[k] ?? 0),
          0,
        );
        const wk = await tx.execute({
          sql: "INSERT OR IGNORE INTO identity_week(week, anon_id) VALUES (?, ?)",
          args: [input.week, input.anonId],
        });
        const weekIsNew = Number(wk.rowsAffected ?? 0) > 0 ? 1 : 0;
        if (!id) {
          await tx.execute({
            sql: "INSERT INTO identity(anon_id, pub_key, first_seen_week, last_seq, created_at, updated_at, activity_total, active_weeks, last_active_week) VALUES (?,?,?,?,?,?,?,?,?)",
            args: [
              input.anonId,
              input.pubKey,
              input.week,
              input.seq,
              input.now,
              input.now,
              totalDelta,
              1,
              input.week,
            ],
          });
        } else {
          await tx.execute({
            sql: "UPDATE identity SET last_seq = ?, updated_at = ?, activity_total = activity_total + ?, active_weeks = active_weeks + ?, last_active_week = ? WHERE anon_id = ?",
            args: [
              input.seq,
              input.now,
              totalDelta,
              weekIsNew,
              input.week,
              input.anonId,
            ],
          });
        }
        for (const kind of COUNTER_KINDS) {
          const delta = input.counters[kind] ?? 0;
          if (delta > 0) {
            await tx.execute({
              sql: "INSERT INTO weekly_counter(week, kind, count) VALUES (?,?,?) ON CONFLICT(week, kind) DO UPDATE SET count = count + excluded.count",
              args: [input.week, kind, delta],
            });
          }
        }
        await tx.commit();
        return { status: "applied" };
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    },

    async aggregateWeek(week: string): Promise<WeekAggregate> {
      await ensure();
      const counters = {} as Counters;
      for (const k of COUNTER_KINDS) counters[k] = 0;
      const rows = await client.execute({
        sql: "SELECT kind, count FROM weekly_counter WHERE week = ?",
        args: [week],
      });
      for (const r of rows.rows as unknown as {
        kind: string;
        count: unknown;
      }[]) {
        if ((COUNTER_KINDS as readonly string[]).includes(r.kind))
          counters[r.kind as keyof Counters] = num(r.count);
      }
      const idc = await client.execute({
        sql: "SELECT COUNT(*) AS n FROM identity_week WHERE week = ?",
        args: [week],
      });
      const nw = await client.execute({
        sql: "SELECT COUNT(*) AS n FROM identity WHERE first_seen_week = ?",
        args: [week],
      });
      const identities = num((idc.rows[0] as unknown as { n: unknown }).n);
      const newIdentities = num((nw.rows[0] as unknown as { n: unknown }).n);
      return {
        week,
        identities,
        newIdentities,
        returningIdentities: Math.max(0, identities - newIdentities),
        counters,
      };
    },

    async listReportWeeks(): Promise<string[]> {
      await ensure();
      const res = await client.execute(
        "SELECT week FROM report ORDER BY week ASC",
      );
      return (res.rows as unknown as { week: string }[]).map((r) => r.week);
    },

    async getReport(week: string): Promise<ReportRow | undefined> {
      await ensure();
      const res = await client.execute({
        sql: "SELECT * FROM report WHERE week = ?",
        args: [week],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      if (!r) return undefined;
      return {
        week: String(r.week),
        version: num(r.version),
        json: String(r.json),
        sha256: String(r.sha256),
        chainTx: str(r.chain_tx),
        chainCluster: str(r.chain_cluster),
        chainExplorer: str(r.chain_explorer),
        chainProgram: str(r.chain_program),
        chainRecordPda: str(r.chain_record_pda),
        createdAt: num(r.created_at),
      };
    },

    async putReport(row: ReportRow): Promise<void> {
      await ensure();
      await client.execute({
        sql: `INSERT INTO report(week, version, json, sha256, chain_tx, chain_cluster, chain_explorer, chain_program, chain_record_pda, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(week) DO UPDATE SET
                version=excluded.version, json=excluded.json, sha256=excluded.sha256,
                chain_tx=excluded.chain_tx, chain_cluster=excluded.chain_cluster, chain_explorer=excluded.chain_explorer,
                chain_program=excluded.chain_program, chain_record_pda=excluded.chain_record_pda, created_at=excluded.created_at`,
        args: [
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
        ],
      });
    },

    async pruneNonces(olderThanMs: number): Promise<number> {
      await ensure();
      const res = await client.execute({
        sql: "DELETE FROM nonce WHERE seen_at < ?",
        args: [olderThanMs],
      });
      return Number(res.rowsAffected ?? 0);
    },

    async getBackup(locator: string): Promise<BackupRow | undefined> {
      await ensure();
      const res = await client.execute({
        sql: "SELECT * FROM vault_backup WHERE locator = ?",
        args: [locator],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      if (!r) return undefined;
      return {
        locator: String(r.locator),
        writeCommit: String(r.write_commit),
        cid: String(r.cid),
        size: num(r.size),
        createdAt: num(r.created_at),
        updatedAt: num(r.updated_at),
      };
    },

    async putBackup(row: BackupRow): Promise<void> {
      await ensure();
      await client.execute({
        sql: `INSERT INTO vault_backup(locator, write_commit, cid, size, created_at, updated_at)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(locator) DO UPDATE SET
                write_commit=excluded.write_commit, cid=excluded.cid, size=excluded.size, updated_at=excluded.updated_at`,
        args: [
          row.locator,
          row.writeCommit,
          row.cid,
          row.size,
          row.createdAt,
          row.updatedAt,
        ],
      });
    },

    async deleteBackup(locator: string): Promise<void> {
      await ensure();
      await client.execute({
        sql: "DELETE FROM vault_backup WHERE locator = ?",
        args: [locator],
      });
    },

    async redeemReferral(
      refId: string,
      commit: string,
      now: number,
    ): Promise<RedeemResult> {
      await ensure();
      const tx = await client.transaction("write");
      try {
        const ins = await tx.execute({
          sql: "INSERT OR IGNORE INTO referral_redeemer(ref_id, redeemer_commit, redeemed_at) VALUES (?,?,?)",
          args: [refId, commit, now],
        });
        const inserted = Number(ins.rowsAffected ?? 0) > 0;
        const distinctInc = inserted ? 1 : 0;
        // `redemptions` counts every open (repeats included); `distinct_redeemers`
        // only unique recipients (distinctInc). Always upsert so repeats count.
        await tx.execute({
          sql: `INSERT INTO referral(ref_id, redemptions, distinct_redeemers, first_redeemed_at, last_redeemed_at, created_at)
                VALUES (?, 1, ?, ?, ?, ?)
                ON CONFLICT(ref_id) DO UPDATE SET
                  redemptions = redemptions + 1,
                  distinct_redeemers = distinct_redeemers + ?,
                  first_redeemed_at = COALESCE(first_redeemed_at, excluded.first_redeemed_at),
                  last_redeemed_at = excluded.last_redeemed_at`,
          args: [refId, distinctInc, now, now, now, distinctInc],
        });
        const res = await tx.execute({
          sql: "SELECT * FROM referral WHERE ref_id = ?",
          args: [refId],
        });
        await tx.commit();
        const row = referralRowFrom(res.rows[0] as Record<string, unknown>);
        return { status: inserted ? "recorded" : "duplicate", row };
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    },

    async getReferral(refId: string): Promise<ReferralRow | undefined> {
      await ensure();
      const res = await client.execute({
        sql: "SELECT * FROM referral WHERE ref_id = ?",
        args: [refId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? referralRowFrom(r) : undefined;
    },

    async getActivity(anonId: string): Promise<ActivityRow | undefined> {
      await ensure();
      const res = await client.execute({
        sql: "SELECT anon_id, activity_total, active_weeks, last_active_week, first_seen_week FROM identity WHERE anon_id = ?",
        args: [anonId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      if (!r) return undefined;
      return {
        anonId: String(r.anon_id),
        activityTotal: num(r.activity_total),
        activeWeeks: num(r.active_weeks),
        lastActiveWeek: str(r.last_active_week),
        firstSeenWeek: String(r.first_seen_week),
      };
    },

    async listActivity(): Promise<ActivityRow[]> {
      await ensure();
      const res = await client.execute(
        "SELECT anon_id, activity_total, active_weeks, last_active_week, first_seen_week FROM identity",
      );
      return (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
        anonId: String(r.anon_id),
        activityTotal: num(r.activity_total),
        activeWeeks: num(r.active_weeks),
        lastActiveWeek: str(r.last_active_week),
        firstSeenWeek: String(r.first_seen_week),
      }));
    },

    async registerIdentity(
      anonId: string,
      _pubKey: string,
      week: string,
      now: number,
    ): Promise<void> {
      await ensure();
      await client.execute({
        sql: "INSERT OR IGNORE INTO install(anon_id, first_seen_week, registered_at) VALUES (?,?,?)",
        args: [anonId, week, now],
      });
    },

    async totalUsers(): Promise<number> {
      await ensure();
      const res = await client.execute(
        "SELECT COUNT(*) AS n FROM (SELECT anon_id FROM install UNION SELECT anon_id FROM identity)",
      );
      return num((res.rows[0] as unknown as { n: unknown }).n);
    },

    async referralTotals(): Promise<ReferralTotals> {
      await ensure();
      const res = await client.execute(
        "SELECT COUNT(*) AS links, COALESCE(SUM(redemptions),0) AS redemptions, COALESCE(SUM(distinct_redeemers),0) AS distinct_redeemers FROM referral",
      );
      const r = res.rows[0] as unknown as {
        links: unknown;
        redemptions: unknown;
        distinct_redeemers: unknown;
      };
      return {
        links: num(r.links),
        redemptions: num(r.redemptions),
        distinctRedeemers: num(r.distinct_redeemers),
      };
    },

    async retentionPoints(): Promise<
      { week: string; active: number; retained: number }[]
    > {
      await ensure();
      const wRes = await client.execute(
        "SELECT DISTINCT week FROM identity_week ORDER BY week ASC",
      );
      const weeks = (wRes.rows as unknown as { week: string }[]).map(
        (r) => r.week,
      );
      const out: { week: string; active: number; retained: number }[] = [];
      for (let i = 0; i < weeks.length - 1; i++) {
        const curRes = await client.execute({
          sql: "SELECT anon_id FROM identity_week WHERE week = ?",
          args: [weeks[i]],
        });
        const nxtRes = await client.execute({
          sql: "SELECT anon_id FROM identity_week WHERE week = ?",
          args: [weeks[i + 1]],
        });
        const cur = new Set(
          (curRes.rows as unknown as { anon_id: string }[]).map(
            (r) => r.anon_id,
          ),
        );
        const nxt = new Set(
          (nxtRes.rows as unknown as { anon_id: string }[]).map(
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
      client.close();
    },
  };
}

function referralRowFrom(r: Record<string, unknown>): ReferralRow {
  return {
    refId: String(r.ref_id),
    redemptions: num(r.redemptions),
    distinctRedeemers: num(r.distinct_redeemers),
    firstRedeemedAt:
      r.first_redeemed_at == null ? null : num(r.first_redeemed_at),
    lastRedeemedAt: r.last_redeemed_at == null ? null : num(r.last_redeemed_at),
    createdAt: num(r.created_at),
  };
}
