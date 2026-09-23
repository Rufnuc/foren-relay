// Validates and cryptographically verifies a usage submission. This is the
// trust boundary: it rejects anything that is not exactly the expected
// counts-only shape (so a client cannot smuggle incident/vault fields through),
// checks the ECDSA P-256 signature against the submitted public key, binds the
// anonymous id to that key, and enforces timestamp freshness.

import { webcrypto, createHash } from "node:crypto";
import { canonicalize } from "./canonical";

const subtle = webcrypto.subtle;

export const COUNTER_KINDS = [
  "record_created",
  "record_updated",
  "evidence_added",
  "verification_performed",
  "export_performed",
] as const;
export type CounterKind = (typeof COUNTER_KINDS)[number];
export type Counters = Record<CounterKind, number>;

const ALLOWED_TOP_KEYS = new Set([
  "v",
  "anonId",
  "pubKey",
  "counters",
  "seq",
  "nonce",
  "issuedAt",
  "signature",
]);

export interface VerifiedSubmission {
  v: 1;
  anonId: string;
  pubKey: string;
  counters: Counters;
  seq: number;
  nonce: string;
  issuedAt: number;
  signature: string;
}

export type VerifyResult =
  | { ok: true; sub: VerifiedSubmission }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): VerifyResult {
  return { ok: false, code, message };
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function bytesToBase64Url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isSafeCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1_000_000;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Full validation + signature verification. `maxSkewMs` bounds how far
 * `issuedAt` may be from the server clock (replay-freshness).
 */
export async function verifySubmission(
  body: unknown,
  opts: { now: number; maxSkewMs: number },
): Promise<VerifyResult> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("bad_request", "body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  // Reject ANY unexpected top-level key — this is what stops a client from
  // attaching incident text, filenames, locations, etc. to a submission.
  for (const k of Object.keys(b)) {
    if (!ALLOWED_TOP_KEYS.has(k)) return fail("unexpected_field", `unexpected field: ${k}`);
  }

  if (b.v !== 1) return fail("bad_version", "v must be 1");
  for (const f of ["anonId", "pubKey", "nonce", "signature"] as const) {
    if (typeof b[f] !== "string" || !(b[f] as string).length || (b[f] as string).length > 4096) {
      return fail("bad_request", `${f} must be a non-empty string`);
    }
    if (!B64URL.test(b[f] as string)) return fail("bad_request", `${f} must be base64url`);
  }
  if (!Number.isInteger(b.seq) || (b.seq as number) < 1) return fail("bad_request", "seq must be a positive integer");
  if (!Number.isInteger(b.issuedAt)) return fail("bad_request", "issuedAt must be an integer (epoch ms)");

  // Counters: only known kinds, non-negative integers, and not entirely empty.
  if (typeof b.counters !== "object" || b.counters === null || Array.isArray(b.counters)) {
    return fail("bad_request", "counters must be an object");
  }
  const rawCounters = b.counters as Record<string, unknown>;
  const counters = {} as Counters;
  let total = 0;
  for (const k of Object.keys(rawCounters)) {
    if (!(COUNTER_KINDS as readonly string[]).includes(k)) return fail("unknown_counter", `unknown counter: ${k}`);
    if (!isSafeCount(rawCounters[k])) return fail("bad_counter", `counter ${k} must be a small non-negative integer`);
  }
  for (const k of COUNTER_KINDS) {
    const val = isSafeCount(rawCounters[k]) ? (rawCounters[k] as number) : 0;
    counters[k] = val;
    total += val;
  }
  if (total === 0) return fail("empty", "submission has no counts");

  // Freshness.
  if (Math.abs(opts.now - (b.issuedAt as number)) > opts.maxSkewMs) {
    return fail("stale", "issuedAt outside the allowed freshness window");
  }

  // Bind anonId to the public key: anonId == base64url(SHA-256(rawPubKey)).
  let rawPub: Uint8Array;
  try {
    rawPub = base64UrlToBytes(b.pubKey as string);
  } catch {
    return fail("bad_request", "pubKey is not valid base64url");
  }
  const derivedAnonId = bytesToBase64Url(new Uint8Array(createHash("sha256").update(rawPub).digest()));
  if (derivedAnonId !== b.anonId) return fail("anonid_mismatch", "anonId does not match pubKey");

  // Import the public key and verify the ECDSA P-256 / SHA-256 signature over
  // the canonical payload (all fields except `signature`).
  let pubKey: webcrypto.CryptoKey;
  try {
    pubKey = await subtle.importKey("raw", rawPub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return fail("bad_pubkey", "pubKey is not a valid P-256 public key");
  }

  const payload = {
    v: 1,
    anonId: b.anonId,
    pubKey: b.pubKey,
    counters,
    seq: b.seq,
    nonce: b.nonce,
    issuedAt: b.issuedAt,
  };
  const msg = new TextEncoder().encode(canonicalize(payload));
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlToBytes(b.signature as string);
  } catch {
    return fail("bad_signature", "signature is not valid base64url");
  }
  const valid = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, sigBytes, msg);
  if (!valid) return fail("bad_signature", "signature verification failed");

  return { ok: true, sub: payload as VerifiedSubmission };
}
