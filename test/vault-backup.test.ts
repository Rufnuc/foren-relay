import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { createHash } from "node:crypto";

import { buildApp } from "../src/server";
import { loadConfig } from "../src/config";
import { MemoryDispatcher } from "../src/services/dispatch";
import { buildUsageService } from "../src/services/usage";
import type { PinningProvider, PinResult } from "../src/services/ipfs";

// A fake pinning provider that actually stores blobs so GET can return them.
class FakePinning implements PinningProvider {
  readonly name = "fake";
  store = new Map<string, Buffer>();
  async pin(blob: Buffer): Promise<PinResult> {
    const cid = "cid" + createHash("sha256").update(blob).digest("hex").slice(0, 24);
    this.store.set(cid, Buffer.from(blob));
    return { cid, size: blob.length, pinnedAt: Date.now() };
  }
  async unpin(cid: string): Promise<void> {
    this.store.delete(cid);
  }
  async cat(cid: string): Promise<Buffer> {
    const b = this.store.get(cid);
    if (!b) throw new Error("not pinned");
    return b;
  }
}

function makeApp() {
  process.env.NODE_ENV = "test";
  process.env.PINNING_PROVIDER = "noop";
  const cfg = loadConfig();
  const usage = buildUsageService({ dbPath: ":memory:", maxSkewMs: cfg.USAGE_MAX_SKEW_MS, nonceRetentionMs: cfg.USAGE_NONCE_RETENTION_MS });
  const pinning = new FakePinning();
  const built = buildApp({ cfg, logger: pino({ level: "silent" }), dispatcher: new MemoryDispatcher(), usage, pinning });
  return { app: built.app, pinning };
}

const LOC = "locator_abc1234567890";
const SECRET = "write-secret-xyz";
const put = (app: unknown, loc: string, secret: string, body: string) =>
  request(app as never)
    .put(`/v1/vault-backup/${loc}`)
    .set("content-type", "application/octet-stream")
    .set("x-write-secret", secret)
    .send(Buffer.from(body));

describe("hosted vault backup", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => {
    ctx = makeApp();
  });

  it("PUT stores a blob and GET returns it byte-for-byte", async () => {
    const blob = "ENCRYPTED-BACKUP-BLOB-💾";
    const p = await put(ctx.app, LOC, SECRET, blob);
    expect(p.status).toBe(200);
    expect(p.body.ok).toBe(true);
    expect(p.body.cid).toMatch(/^cid/);

    const g = await request(ctx.app).get(`/v1/vault-backup/${LOC}`);
    expect(g.status).toBe(200);
    expect(g.headers["content-type"]).toContain("application/octet-stream");
    expect(Buffer.from(g.body).toString("utf8")).toBe(blob);
  });

  it("rejects overwrite with the wrong write secret", async () => {
    await put(ctx.app, LOC, SECRET, "v1");
    const bad = await put(ctx.app, LOC, "wrong-secret", "v2");
    expect(bad.status).toBe(403);
    // original is intact
    const g = await request(ctx.app).get(`/v1/vault-backup/${LOC}`);
    expect(Buffer.from(g.body).toString("utf8")).toBe("v1");
  });

  it("allows overwrite with the correct secret and drops the old blob", async () => {
    await put(ctx.app, LOC, SECRET, "v1");
    const before = ctx.pinning.store.size;
    const ok = await put(ctx.app, LOC, SECRET, "v2-updated");
    expect(ok.status).toBe(200);
    const g = await request(ctx.app).get(`/v1/vault-backup/${LOC}`);
    expect(Buffer.from(g.body).toString("utf8")).toBe("v2-updated");
    // old cid was unpinned → still only one stored blob
    expect(ctx.pinning.store.size).toBe(before);
  });

  it("GET 404 for an unknown locator", async () => {
    const g = await request(ctx.app).get("/v1/vault-backup/does_not_exist_1234567");
    expect(g.status).toBe(404);
  });

  it("rejects a malformed locator", async () => {
    expect((await request(ctx.app).get("/v1/vault-backup/short")).status).toBe(400);
    expect((await put(ctx.app, "bad locator!", SECRET, "x")).status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const p = await request(ctx.app)
      .put(`/v1/vault-backup/${LOC}`)
      .set("content-type", "application/octet-stream")
      .set("x-write-secret", SECRET)
      .send(Buffer.alloc(0));
    expect(p.status).toBe(400);
  });

  it("DELETE requires the write secret, then removes the backup", async () => {
    await put(ctx.app, LOC, SECRET, "v1");
    expect((await request(ctx.app).delete(`/v1/vault-backup/${LOC}`).set("x-write-secret", "nope")).status).toBe(403);
    const del = await request(ctx.app).delete(`/v1/vault-backup/${LOC}`).set("x-write-secret", SECRET);
    expect(del.status).toBe(200);
    expect((await request(ctx.app).get(`/v1/vault-backup/${LOC}`)).status).toBe(404);
    expect(ctx.pinning.store.size).toBe(0);
  });
});
