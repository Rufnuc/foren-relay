import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { webcrypto, createHash } from "node:crypto";

import { buildApp } from "../src/server";
import { loadConfig } from "../src/config";
import { MemoryDispatcher } from "../src/services/dispatch";
import { buildUsageService, buildWeeklyReport, type UsageService } from "../src/services/usage";
import { buildLibsqlUsageStore } from "../src/services/usage/store_libsql";
import { canonicalize, isoWeek } from "../src/services/usage/canonical";
import type { Counters } from "../src/services/usage/verify";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const subtle = webcrypto.subtle;
const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Ident {
  priv: webcrypto.CryptoKey;
  pubKey: string;
  anonId: string;
}

async function makeIdentity(): Promise<Ident> {
  const pair = await subtle.generateKey(EC, true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return {
    priv: pair.privateKey,
    pubKey: b64url(rawPub),
    anonId: b64url(new Uint8Array(createHash("sha256").update(rawPub).digest())),
  };
}

function zero(): Counters {
  return {
    record_created: 0,
    record_updated: 0,
    evidence_added: 0,
    verification_performed: 0,
    export_performed: 0,
  };
}

async function sign(
  id: Ident,
  opts: { counters: Partial<Counters>; seq: number; nonce?: string; issuedAt?: number },
) {
  const payload = {
    v: 1 as const,
    anonId: id.anonId,
    pubKey: id.pubKey,
    counters: { ...zero(), ...opts.counters },
    seq: opts.seq,
    nonce: opts.nonce ?? b64url(webcrypto.getRandomValues(new Uint8Array(16))),
    issuedAt: opts.issuedAt ?? Date.now(),
  };
  const msg = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign(SIGN, id.priv, msg));
  return { ...payload, signature: b64url(sig) };
}

function makeApp(overrides: Record<string, string> = {}) {
  process.env.NODE_ENV = "test";
  process.env.PINNING_PROVIDER = "noop";
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  const cfg = loadConfig();
  const usage = buildUsageService({ dbPath: ":memory:", maxSkewMs: cfg.USAGE_MAX_SKEW_MS, nonceRetentionMs: cfg.USAGE_NONCE_RETENTION_MS });
  const built = buildApp({ cfg, logger: pino({ level: "silent" }), dispatcher: new MemoryDispatcher(), usage });
  return { app: built.app, usage: usage as UsageService };
}

describe("usage: canonical serialization + hashing", () => {
  it("sorts keys and omits whitespace deterministically", () => {
    expect(canonicalize({ b: 1, a: 2, c: [3, 2] })).toBe('{"a":2,"b":1,"c":[3,2]}');
    // Key order in the source object must not change the output.
    expect(canonicalize({ a: 2, b: 1, c: [3, 2] })).toBe(canonicalize({ c: [3, 2], b: 1, a: 2 }));
  });

  it("rejects non-integer numbers", () => {
    expect(() => canonicalize({ x: 1.5 })).toThrow();
  });

  it("weekly report hash equals SHA-256 of its canonical JSON", () => {
    const built = buildWeeklyReport(
      { week: "2026-W39", identities: 5, newIdentities: 2, returningIdentities: 3, counters: { ...zero(), record_created: 9 } },
      1,
    );
    expect(built.sha256).toBe(createHash("sha256").update(built.json, "utf8").digest("hex"));
    expect(built.json).toBe(canonicalize(built.report));
  });

  it("isoWeek buckets by UTC ISO week", () => {
    expect(isoWeek(Date.UTC(2026, 8, 23))).toBe("2026-W39"); // 23 Sep 2026 (Wed)
  });
});

describe("usage: submission verification (HTTP)", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("accepts a valid signed submission", async () => {
    const id = await makeIdentity();
    const sub = await sign(id, { counters: { record_created: 4, evidence_added: 7 }, seq: 1 });
    const res = await request(ctx.app).post("/v1/usage").send(sub);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "applied" });

    const agg = await ctx.usage.store.aggregateWeek(isoWeek(Date.now()));
    expect(agg.counters.record_created).toBe(4);
    expect(agg.counters.evidence_added).toBe(7);
    expect(agg.identities).toBe(1);
    expect(agg.newIdentities).toBe(1);
  });

  it("rejects a tampered signature", async () => {
    const id = await makeIdentity();
    const sub = await sign(id, { counters: { record_created: 1 }, seq: 1 });
    sub.counters.record_created = 999; // change counts after signing
    const res = await request(ctx.app).post("/v1/usage").send(sub);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_signature");
  });

  it("rejects an anonId that does not match the public key", async () => {
    const id = await makeIdentity();
    const other = await makeIdentity();
    const sub = await sign(id, { counters: { record_created: 1 }, seq: 1 });
    sub.anonId = other.anonId; // now inconsistent → signature also fails first
    const res = await request(ctx.app).post("/v1/usage").send(sub);
    expect(res.status).toBe(400);
  });

  it("rejects unexpected fields (no vault/incident data can be smuggled)", async () => {
    const id = await makeIdentity();
    const sub = (await sign(id, { counters: { record_created: 1 }, seq: 1 })) as Record<string, unknown>;
    sub.content = "he threatened me at the station"; // attempt to attach incident data
    const res = await request(ctx.app).post("/v1/usage").send(sub);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unexpected_field");
  });

  it("rejects an unknown counter kind", async () => {
    const id = await makeIdentity();
    const sub = (await sign(id, { counters: { record_created: 1 }, seq: 1 })) as Record<string, unknown>;
    (sub.counters as Record<string, unknown>).location = 5;
    const res = await request(ctx.app).post("/v1/usage").send(sub);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unknown_counter");
  });

  it("rejects empty counters", async () => {
    const id = await makeIdentity();
    const sub = await sign(id, { counters: {}, seq: 1 });
    const res = await request(ctx.app).post("/v1/usage").send(sub);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("empty");
  });

  it("rejects a stale timestamp", async () => {
    const id = await makeIdentity();
    const sub = await sign(id, { counters: { record_created: 1 }, seq: 1, issuedAt: Date.now() - 20 * 60 * 1000 });
    const res = await request(ctx.app).post("/v1/usage").send(sub);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("stale");
  });

  it("rejects a malformed body", async () => {
    const res = await request(ctx.app).post("/v1/usage").send([1, 2, 3]);
    expect(res.status).toBe(400);
  });
});

describe("usage: replay / duplicate / sequence", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("counts a delta once and ignores a replay of the same seq", async () => {
    const id = await makeIdentity();
    const s1 = await sign(id, { counters: { record_created: 3 }, seq: 1 });
    expect((await request(ctx.app).post("/v1/usage").send(s1)).body.status).toBe("applied");

    // Resend the SAME seq with a fresh nonce (a retry) — must be idempotent.
    const s1b = await sign(id, { counters: { record_created: 3 }, seq: 1 });
    const res = await request(ctx.app).post("/v1/usage").send(s1b);
    expect(res.body.status).toBe("duplicate");

    const agg = await ctx.usage.store.aggregateWeek(isoWeek(Date.now()));
    expect(agg.counters.record_created).toBe(3); // NOT 6
  });

  it("applies the next sequence and rejects a reused nonce", async () => {
    const id = await makeIdentity();
    const nonce = b64url(webcrypto.getRandomValues(new Uint8Array(16)));
    await request(ctx.app).post("/v1/usage").send(await sign(id, { counters: { evidence_added: 2 }, seq: 1, nonce }));
    // seq 2 but REUSING the earlier nonce → rejected by the nonce table.
    const res = await request(ctx.app).post("/v1/usage").send(await sign(id, { counters: { evidence_added: 5 }, seq: 2, nonce }));
    expect(res.body.status).toBe("nonce_reused");

    // A clean seq 2 with a fresh nonce is applied and added.
    await request(ctx.app).post("/v1/usage").send(await sign(id, { counters: { evidence_added: 5 }, seq: 2 }));
    const agg = await ctx.usage.store.aggregateWeek(isoWeek(Date.now()));
    expect(agg.counters.evidence_added).toBe(7);
  });
});

describe("usage: aggregation + weekly bucketing + new/returning (store)", () => {
  it("buckets by server week and distinguishes new vs returning identities", async () => {
    const usage = buildUsageService({ dbPath: ":memory:", maxSkewMs: 600000, nonceRetentionMs: 86400000 });
    const wk1 = "2026-W39";
    const wk2 = "2026-W40";
    const w1 = Date.UTC(2026, 8, 23);
    const w2 = Date.UTC(2026, 8, 30);

    // Two identities active in week 1.
    await usage.store.apply({ anonId: "A", pubKey: "pA", week: wk1, counters: { ...zero(), record_created: 2 }, seq: 1, nonce: "n1", now: w1 });
    await usage.store.apply({ anonId: "B", pubKey: "pB", week: wk1, counters: { ...zero(), evidence_added: 3 }, seq: 1, nonce: "n2", now: w1 });
    // Week 2: A returns, C is new.
    await usage.store.apply({ anonId: "A", pubKey: "pA", week: wk2, counters: { ...zero(), export_performed: 1 }, seq: 2, nonce: "n3", now: w2 });
    await usage.store.apply({ anonId: "C", pubKey: "pC", week: wk2, counters: { ...zero(), record_created: 1 }, seq: 1, nonce: "n4", now: w2 });

    const a1 = await usage.store.aggregateWeek(wk1);
    expect(a1.identities).toBe(2);
    expect(a1.newIdentities).toBe(2);
    expect(a1.returningIdentities).toBe(0);
    expect(a1.counters.record_created).toBe(2);

    const a2 = await usage.store.aggregateWeek(wk2);
    expect(a2.identities).toBe(2); // A + C
    expect(a2.newIdentities).toBe(1); // C only (A first seen in wk1)
    expect(a2.returningIdentities).toBe(1); // A
    await usage.close();
  });
});

describe("usage: reports + rate limiting", () => {
  it("lists and serves a stored weekly report", async () => {
    const ctx = makeApp();
    const built = buildWeeklyReport(
      { week: "2026-W39", identities: 3, newIdentities: 3, returningIdentities: 0, counters: { ...zero(), record_created: 12 } },
      1,
    );
    await ctx.usage.store.putReport({
      week: "2026-W39",
      version: 1,
      json: built.json,
      sha256: built.sha256,
      chainTx: "TESTSIG",
      chainCluster: "devnet",
      chainExplorer: "https://explorer.solana.com/tx/TESTSIG?cluster=devnet",
      chainProgram: "prog",
      chainRecordPda: "pda",
      createdAt: Date.now(),
    });

    const list = await request(ctx.app).get("/v1/usage/reports");
    expect(list.body.weeks).toContain("2026-W39");

    const rep = await request(ctx.app).get("/v1/usage/reports/2026-W39");
    expect(rep.status).toBe(200);
    expect(rep.body.sha256).toBe(built.sha256);
    // The served JSON must re-hash to the published hash (public-page check).
    expect(createHash("sha256").update(rep.body.reportJson, "utf8").digest("hex")).toBe(built.sha256);
    expect(rep.body.report.metrics.records_created).toBe(12);
  });

  it("returns 404 for an unknown week", async () => {
    const ctx = makeApp();
    const res = await request(ctx.app).get("/v1/usage/reports/1999-W01");
    expect(res.status).toBe(404);
  });

  it("rate-limits excessive submissions", async () => {
    const ctx = makeApp({ RATE_LIMIT_USAGE_PER_MIN: "2" });
    const id = await makeIdentity();
    const codes: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const res = await request(ctx.app).post("/v1/usage").send(await sign(id, { counters: { record_created: 1 }, seq: i }));
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
  });
});

describe("usage: libSQL backend parity (durable store)", () => {
  it("applies, dedups, buckets and stores reports via libSQL (file mode)", async () => {
    const path = join(tmpdir(), `foren-usage-libsql-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = buildLibsqlUsageStore(`file:${path}`);
    try {
      const wk = "2026-W39";
      const now = Date.UTC(2026, 8, 23);
      const z = zero();
      expect((await store.apply({ anonId: "A", pubKey: "pA", week: wk, counters: { ...z, record_created: 4 }, seq: 1, nonce: "x1", now })).status).toBe("applied");
      // Idempotent retry (seq not advanced) — must not double count.
      expect((await store.apply({ anonId: "A", pubKey: "pA", week: wk, counters: { ...z, record_created: 4 }, seq: 1, nonce: "x2", now })).status).toBe("duplicate");
      // Nonce reuse rejected.
      expect((await store.apply({ anonId: "A", pubKey: "pA", week: wk, counters: { ...z, record_created: 4 }, seq: 2, nonce: "x1", now })).status).toBe("nonce_reused");
      // A second identity + a real seq-2 delta.
      await store.apply({ anonId: "B", pubKey: "pB", week: wk, counters: { ...z, evidence_added: 7 }, seq: 1, nonce: "x3", now });
      await store.apply({ anonId: "A", pubKey: "pA", week: wk, counters: { ...z, record_created: 1 }, seq: 2, nonce: "x4", now });

      const agg = await store.aggregateWeek(wk);
      expect(agg.identities).toBe(2);
      expect(agg.newIdentities).toBe(2);
      expect(agg.counters.record_created).toBe(5); // 4 + 1, retry not counted
      expect(agg.counters.evidence_added).toBe(7);

      const built = buildWeeklyReport(agg, 1);
      await store.putReport({
        week: wk, version: 1, json: built.json, sha256: built.sha256,
        chainTx: "TX", chainCluster: "devnet", chainExplorer: "e", chainProgram: "p", chainRecordPda: "pda",
        createdAt: now,
      });
      expect(await store.listReportWeeks()).toContain(wk);
      const rep = await store.getReport(wk);
      expect(rep?.sha256).toBe(built.sha256);
      expect(createHash("sha256").update(rep!.json, "utf8").digest("hex")).toBe(built.sha256);
      await store.close();
    } finally {
      for (const suffix of ["", "-shm", "-wal"]) {
        try { rmSync(path + suffix); } catch { /* ignore */ }
      }
    }
  });
});
