import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { webcrypto, createHash } from "node:crypto";

import { buildApp } from "../src/server";
import { loadConfig } from "../src/config";
import { MemoryDispatcher } from "../src/services/dispatch";
import { buildUsageService, type UsageService } from "../src/services/usage";
import { canonicalize } from "../src/services/usage/canonical";

const subtle = webcrypto.subtle;
const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
    anonId: b64url(
      new Uint8Array(createHash("sha256").update(rawPub).digest()),
    ),
  };
}

/** Sign a generic envelope with the given extra fields (e.g. { refId }). */
async function signEnvelope(
  id: Ident,
  extra: Record<string, string>,
  issuedAt = Date.now(),
) {
  const payload: Record<string, unknown> = {
    v: 1,
    anonId: id.anonId,
    pubKey: id.pubKey,
    nonce: b64url(webcrypto.getRandomValues(new Uint8Array(16))),
    issuedAt,
    ...extra,
  };
  const sig = new Uint8Array(
    await subtle.sign(
      SIGN,
      id.priv,
      new TextEncoder().encode(canonicalize(payload)),
    ),
  );
  return { ...payload, signature: b64url(sig) };
}

/** A referral id as the client derives it: base64url(SHA-256("foren-ref|"+code)). */
function refIdFor(code: string): string {
  return b64url(
    new Uint8Array(createHash("sha256").update(`foren-ref|${code}`).digest()),
  );
}

function makeApp(overrides: Record<string, string> = {}) {
  process.env.NODE_ENV = "test";
  process.env.PINNING_PROVIDER = "noop";
  delete process.env.USAGE_ADMIN_TOKEN;
  delete process.env.METRICS_TOKEN;
  delete process.env.METRICS_PUBLIC;
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  const cfg = loadConfig();
  const usage = buildUsageService({
    dbPath: ":memory:",
    maxSkewMs: cfg.USAGE_MAX_SKEW_MS,
    nonceRetentionMs: cfg.USAGE_NONCE_RETENTION_MS,
  });
  const built = buildApp({
    cfg,
    logger: pino({ level: "silent" }),
    dispatcher: new MemoryDispatcher(),
    usage,
  });
  return { app: built.app, usage: usage as UsageService };
}

describe("referral: redeem + reuse stats", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("records a redemption and reports reuse stats without revealing redeemers", async () => {
    const refId = refIdFor("HELP-ABCD-1234");
    const alice = await makeIdentity();
    const bob = await makeIdentity();

    const r1 = await request(ctx.app)
      .post("/v1/referral/redeem")
      .send(await signEnvelope(alice, { refId }));
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe("recorded");
    expect(r1.body.referral.distinctRedeemers).toBe(1);
    expect(r1.body.referral.reused).toBe(false);

    const r2 = await request(ctx.app)
      .post("/v1/referral/redeem")
      .send(await signEnvelope(bob, { refId }));
    expect(r2.body.status).toBe("recorded");
    expect(r2.body.referral.distinctRedeemers).toBe(2);
    expect(r2.body.referral.reused).toBe(true);

    // Public stats query by the creator (who holds the code → refId).
    const stats = await request(ctx.app).get(`/v1/referral/${refId}`);
    expect(stats.status).toBe(200);
    expect(stats.body.redemptions).toBe(2);
    expect(stats.body.distinctRedeemers).toBe(2);
    // The response must not carry any redeemer identity/commitment.
    expect(JSON.stringify(stats.body)).not.toContain("anonId");
    expect(stats.body).not.toHaveProperty("redeemer_commit");
  });

  it("dedupes the same redeemer (idempotent) — reuse counts distinct people only", async () => {
    const refId = refIdFor("SAME-USER-TWICE");
    const alice = await makeIdentity();

    const first = await request(ctx.app)
      .post("/v1/referral/redeem")
      .send(await signEnvelope(alice, { refId }));
    expect(first.body.status).toBe("recorded");
    const again = await request(ctx.app)
      .post("/v1/referral/redeem")
      .send(await signEnvelope(alice, { refId }));
    expect(again.body.status).toBe("duplicate");
    // Distinct people stays 1, but a repeat open still counts toward total opens.
    expect(again.body.referral.distinctRedeemers).toBe(1);
    expect(again.body.referral.redemptions).toBe(2);
    expect(again.body.referral.reused).toBe(false); // reused = >1 distinct person
  });

  it("rejects a forged signature", async () => {
    const refId = refIdFor("FORGED");
    const alice = await makeIdentity();
    const env = await signEnvelope(alice, { refId });
    env.signature = b64url(new Uint8Array(64)); // zeroed
    const res = await request(ctx.app).post("/v1/referral/redeem").send(env);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_signature");
  });

  it("rejects a malformed refId", async () => {
    const alice = await makeIdentity();
    const res = await request(ctx.app)
      .post("/v1/referral/redeem")
      .send(await signEnvelope(alice, { refId: "short" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bad_ref");
  });

  it("404s for an unknown link", async () => {
    const res = await request(ctx.app).get(
      `/v1/referral/${refIdFor("never-used")}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("activity: signed self-score", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("returns a bounded score that grows with usage", async () => {
    const alice = await makeIdentity();

    // No usage yet → score 0.
    const zero = await request(ctx.app)
      .post("/v1/activity/score")
      .send(await signEnvelope(alice, {}));
    expect(zero.status).toBe(200);
    expect(zero.body.score).toBe(0);
    expect(zero.body.totalActions).toBe(0);

    // Submit some usage under the same identity.
    const sub = {
      v: 1,
      anonId: alice.anonId,
      pubKey: alice.pubKey,
      counters: {
        record_created: 12,
        record_updated: 0,
        evidence_added: 8,
        verification_performed: 0,
        export_performed: 0,
      },
      seq: 1,
      nonce: b64url(webcrypto.getRandomValues(new Uint8Array(16))),
      issuedAt: Date.now(),
    };
    const msg = new TextEncoder().encode(canonicalize(sub));
    const sig = b64url(
      new Uint8Array(await subtle.sign(SIGN, alice.priv, msg)),
    );
    const posted = await request(ctx.app)
      .post("/v1/usage")
      .send({ ...sub, signature: sig });
    expect(posted.status).toBe(200);

    const scored = await request(ctx.app)
      .post("/v1/activity/score")
      .send(await signEnvelope(alice, {}));
    expect(scored.status).toBe(200);
    expect(scored.body.totalActions).toBe(20);
    expect(scored.body.score).toBeGreaterThan(0);
    expect(scored.body.score).toBeLessThanOrEqual(100);
    expect(scored.body.percentile).toBeGreaterThan(0);
    expect(scored.body.population).toBeGreaterThanOrEqual(1);
  });
});

describe("analytics: admin-gated", () => {
  it("404 when no admin token configured", async () => {
    const ctx = makeApp();
    const res = await request(ctx.app).get("/v1/usage/analytics");
    expect(res.status).toBe(404);
  });

  it("401 without the bearer, 200 with it", async () => {
    const ctx = makeApp({ USAGE_ADMIN_TOKEN: "s3cret-token" });
    const noauth = await request(ctx.app).get("/v1/usage/analytics");
    expect(noauth.status).toBe(401);

    const ok = await request(ctx.app)
      .get("/v1/usage/analytics")
      .set("authorization", "Bearer s3cret-token");
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty("activity");
    expect(ok.body).toHaveProperty("scores");
    expect(ok.body.referrals).toHaveProperty("kFactor");
    expect(ok.body).toHaveProperty("retention");
  });
});

describe("metrics: read-only dashboard feed", () => {
  it("404 when neither metrics nor admin token configured and not public", async () => {
    const ctx = makeApp();
    const res = await request(ctx.app).get("/v1/usage/metrics");
    expect(res.status).toBe(404);
  });

  it("401 without the key, 200 with the read-only key (via ?k= or Bearer)", async () => {
    const ctx = makeApp({ METRICS_TOKEN: "read-key" });
    expect((await request(ctx.app).get("/v1/usage/metrics")).status).toBe(401);
    expect(
      (await request(ctx.app).get("/v1/usage/metrics?k=wrong")).status,
    ).toBe(401);

    const viaQuery = await request(ctx.app).get("/v1/usage/metrics?k=read-key");
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.body).toHaveProperty("referrals");

    const viaHeader = await request(ctx.app)
      .get("/v1/usage/metrics")
      .set("authorization", "Bearer read-key");
    expect(viaHeader.status).toBe(200);
  });

  it("the admin token also opens the metrics feed", async () => {
    const ctx = makeApp({ USAGE_ADMIN_TOKEN: "admin-key" });
    const ok = await request(ctx.app).get("/v1/usage/metrics?k=admin-key");
    expect(ok.status).toBe(200);
  });

  it("METRICS_PUBLIC=true serves the feed with no key", async () => {
    const ctx = makeApp({ METRICS_PUBLIC: "true" });
    const ok = await request(ctx.app).get("/v1/usage/metrics");
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty("activity");
    expect(ok.body).toHaveProperty("activeUsers");
  });
});

describe("register: idle installs count as users", () => {
  async function signUsage(id: Ident, counters: Record<string, number>) {
    const sub = {
      v: 1,
      anonId: id.anonId,
      pubKey: id.pubKey,
      counters: {
        record_created: 0,
        record_updated: 0,
        evidence_added: 0,
        verification_performed: 0,
        export_performed: 0,
        ...counters,
      },
      seq: 1,
      nonce: b64url(webcrypto.getRandomValues(new Uint8Array(16))),
      issuedAt: Date.now(),
    };
    const sig = b64url(
      new Uint8Array(
        await subtle.sign(
          SIGN,
          id.priv,
          new TextEncoder().encode(canonicalize(sub)),
        ),
      ),
    );
    return { ...sub, signature: sig };
  }

  it("a registered install counts as a user but not an active user", async () => {
    const ctx = makeApp({ METRICS_PUBLIC: "true" });
    const a = await makeIdentity();

    const reg = await request(ctx.app)
      .post("/v1/usage/register")
      .send(await signEnvelope(a, {}));
    expect(reg.status).toBe(200);
    expect(reg.body.status).toBe("registered");
    // Idempotent — registering again doesn't double-count.
    await request(ctx.app)
      .post("/v1/usage/register")
      .send(await signEnvelope(a, {}));

    const m = await request(ctx.app).get("/v1/usage/metrics");
    expect(m.body.population).toBe(1); // counted as a user
    expect(m.body.activeUsers).toBe(0); // no action yet
  });

  it("acting after registering keeps the user counted once (union)", async () => {
    const ctx = makeApp({ METRICS_PUBLIC: "true" });
    const a = await makeIdentity();
    await request(ctx.app)
      .post("/v1/usage/register")
      .send(await signEnvelope(a, {}));
    const posted = await request(ctx.app)
      .post("/v1/usage")
      .send(await signUsage(a, { record_created: 3 }));
    expect(posted.status).toBe(200);

    const m = await request(ctx.app).get("/v1/usage/metrics");
    expect(m.body.population).toBe(1); // install ∪ active — still one person
    expect(m.body.activeUsers).toBe(1);
  });

  it("rejects a forged register", async () => {
    const ctx = makeApp({ METRICS_PUBLIC: "true" });
    const a = await makeIdentity();
    const env = await signEnvelope(a, {});
    (env as { signature: string }).signature = b64url(new Uint8Array(64));
    const res = await request(ctx.app).post("/v1/usage/register").send(env);
    expect(res.status).toBe(400);
  });
});
