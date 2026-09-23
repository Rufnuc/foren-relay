// Durable, free-tier-friendly backend on libSQL / Turso (SQLite over HTTP).
// Same schema and SQL dialect as the local node:sqlite store, so behaviour is
// identical; only the driver differs. Selected when a libSQL URL is configured
// (see index.ts); otherwise the local store is used. The remote client is
// pure-JS (fetch), so there is nothing native to compile on the host.

import { createClient, type Client } from "@libsql/client";
import { COUNTER_KINDS, type Counters } from "./verify";
import {
  USAGE_SCHEMA_STATEMENTS,
  type ApplyInput,
  type ApplyResult,
  type ReportRow,
  type UsageStore,
  type WeekAggregate,
} from "./store";

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string | null => (v == null ? null : String(v));

export function buildLibsqlUsageStore(url: string, authToken?: string): UsageStore {
  const client: Client = createClient({ url, authToken });

  // Create the schema once, lazily, so the builder can stay synchronous.
  let ensured: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    if (!ensured) {
      ensured = (async () => {
        for (const sql of USAGE_SCHEMA_STATEMENTS) await client.execute(sql);
      })();
    }
    return ensured;
  };

  return {
    async apply(input: ApplyInput): Promise<ApplyResult> {
      await ensure();
      const tx = await client.transaction("write");
      try {
        const nonceHit = await tx.execute({ sql: "SELECT 1 FROM nonce WHERE nonce = ?", args: [input.nonce] });
        if (nonceHit.rows.length) {
          await tx.commit();
          return { status: "nonce_reused" };
        }
        const idRes = await tx.execute({
          sql: "SELECT anon_id, last_seq, first_seen_week FROM identity WHERE anon_id = ?",
          args: [input.anonId],
        });
        const id = idRes.rows[0] as unknown as { last_seq: unknown } | undefined;

        if (id && input.seq <= num(id.last_seq)) {
          await tx.execute({ sql: "INSERT INTO nonce(nonce, seen_at) VALUES (?, ?)", args: [input.nonce, input.now] });
          await tx.commit();
          return { status: "duplicate" };
        }

        await tx.execute({ sql: "INSERT INTO nonce(nonce, seen_at) VALUES (?, ?)", args: [input.nonce, input.now] });
        if (!id) {
          await tx.execute({
            sql: "INSERT INTO identity(anon_id, pub_key, first_seen_week, last_seq, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            args: [input.anonId, input.pubKey, input.week, input.seq, input.now, input.now],
          });
        } else {
          await tx.execute({
            sql: "UPDATE identity SET last_seq = ?, updated_at = ? WHERE anon_id = ?",
            args: [input.seq, input.now, input.anonId],
          });
        }
        await tx.execute({
          sql: "INSERT OR IGNORE INTO identity_week(week, anon_id) VALUES (?, ?)",
          args: [input.week, input.anonId],
        });
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
      const rows = await client.execute({ sql: "SELECT kind, count FROM weekly_counter WHERE week = ?", args: [week] });
      for (const r of rows.rows as unknown as { kind: string; count: unknown }[]) {
        if ((COUNTER_KINDS as readonly string[]).includes(r.kind)) counters[r.kind as keyof Counters] = num(r.count);
      }
      const idc = await client.execute({ sql: "SELECT COUNT(*) AS n FROM identity_week WHERE week = ?", args: [week] });
      const nw = await client.execute({ sql: "SELECT COUNT(*) AS n FROM identity WHERE first_seen_week = ?", args: [week] });
      const identities = num((idc.rows[0] as unknown as { n: unknown }).n);
      const newIdentities = num((nw.rows[0] as unknown as { n: unknown }).n);
      return { week, identities, newIdentities, returningIdentities: Math.max(0, identities - newIdentities), counters };
    },

    async listReportWeeks(): Promise<string[]> {
      await ensure();
      const res = await client.execute("SELECT week FROM report ORDER BY week ASC");
      return (res.rows as unknown as { week: string }[]).map((r) => r.week);
    },

    async getReport(week: string): Promise<ReportRow | undefined> {
      await ensure();
      const res = await client.execute({ sql: "SELECT * FROM report WHERE week = ?", args: [week] });
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
      const res = await client.execute({ sql: "DELETE FROM nonce WHERE seen_at < ?", args: [olderThanMs] });
      return Number(res.rowsAffected ?? 0);
    },

    async close(): Promise<void> {
      client.close();
    },
  };
}
