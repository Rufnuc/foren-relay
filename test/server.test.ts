import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import pino from "pino";

import { buildApp } from "../src/server";
import { loadConfig } from "../src/config";
import { MemoryDispatcher } from "../src/services/dispatch";
import type { PinningProvider, PinResult } from "../src/services/ipfs";

class FakePinning implements PinningProvider {
  readonly name = "fake";
  public last: Buffer | null = null;
  async pin(blob: Buffer): Promise<PinResult> {
    this.last = blob;
    return {
      cid: `bafyTEST${blob.length.toString(16).padStart(46, "0")}`,
      size: blob.length,
      pinnedAt: 1700000000000,
    };
  }
  async unpin(): Promise<void> {}
}

describe("relay HTTP", () => {
  let app: ReturnType<typeof buildApp>["app"];
  let pinning: FakePinning;
  let dispatcher: MemoryDispatcher;

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    process.env.PINNING_PROVIDER = "noop";
    const cfg = loadConfig();
    pinning = new FakePinning();
    dispatcher = new MemoryDispatcher();
    const built = buildApp({
      cfg,
      logger: pino({ level: "silent" }),
      pinning,
      dispatcher,
    });
    app = built.app;
  });

  it("GET /livez returns ok", async () => {
    const res = await request(app).get("/livez");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("GET /readyz reports component status", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pinning).toBe("fake");
  });

  it("POST /v1/pin with raw octet-stream forwards the blob to the provider", async () => {
    const blob = Buffer.from("encrypted-test-blob");
    const res = await request(app)
      .post("/v1/pin")
      .set("Content-Type", "application/octet-stream")
      .send(blob);
    expect(res.status).toBe(200);
    expect(res.body.cid).toMatch(/^bafyTEST/);
    expect(res.body.size).toBe(blob.length);
    expect(pinning.last?.equals(blob)).toBe(true);
  });

  it("POST /v1/pin rejects an empty body", async () => {
    const res = await request(app)
      .post("/v1/pin")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.code).toBeDefined();
  });

  it("POST /v1/emergency/dispatch fans out and hashes the recipient address", async () => {
    const res = await request(app)
      .post("/v1/emergency/dispatch")
      .send({
        recipients: [
          { channel: "sms", to: "+15555550100" },
          { channel: "email", to: "ally@example.test" },
        ],
        payload: { ciphertext: "OPAQUE_BLOB" },
      });
    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(2);
    expect(res.body.failures).toEqual([]);
    expect(dispatcher.sent).toHaveLength(2);
    // The raw recipient is delivered to the channel but never echoed back.
    expect(JSON.stringify(res.body)).not.toContain("+15555550100");
    expect(JSON.stringify(res.body)).not.toContain("ally@example.test");
  });

  it("POST /v1/emergency/dispatch rejects malformed bodies", async () => {
    const res = await request(app)
      .post("/v1/emergency/dispatch")
      .send({ recipients: [], payload: { ciphertext: "x" } });
    expect(res.status).toBe(400);
  });

  it("returns 404 with structured error on unknown route", async () => {
    const res = await request(app).get("/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });
});
