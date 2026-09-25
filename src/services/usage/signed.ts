// A small, reusable verifier for signed "envelope" requests that prove control
// of an anonymous identity WITHOUT revealing anything about the person. Used by
// the referral-redeem and activity-score endpoints, which — like usage
// submissions — carry an ECDSA P-256 public key, the anonId derived from it, a
// nonce + issuedAt for replay-freshness, and a signature over the canonical
// payload (every field except `signature`).
//
// This is deliberately the SAME trust model as services/usage/verify.ts: the
// relay learns only an opaque, key-derived id. It cannot map that id to a
// person, a device, an IP (usage requests are not access-logged), or — crucially
// for referrals — to whoever created a link.

import { webcrypto, createHash } from "node:crypto";
import { canonicalize } from "./canonical";

const subtle = webcrypto.subtle;
const B64URL = /^[A-Za-z0-9_-]+$/;

export type EnvelopeResult<T> =
  | { ok: true; anonId: string; fields: T }
  | { ok: false; code: string; message: string };

function fail(
  code: string,
  message: string,
): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function bytesToBase64Url(b: Uint8Array): string {
  return Buffer.from(b)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Verify a signed envelope. `extraFields` names the request-specific string
 * fields that are part of the signed payload (e.g. `["refId"]`), each validated
 * as a non-empty, bounded base64url string. On success the caller gets the
 * derived `anonId` and the validated extra fields. The envelope always carries
 * `v:1, anonId, pubKey, nonce, issuedAt, signature` plus the extra fields.
 */
export async function verifySignedEnvelope<T extends Record<string, string>>(
  body: unknown,
  extraFields: readonly (keyof T & string)[],
  opts: { now: number; maxSkewMs: number },
): Promise<EnvelopeResult<T>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("bad_request", "body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const allowed = new Set<string>([
    "v",
    "anonId",
    "pubKey",
    "nonce",
    "issuedAt",
    "signature",
    ...extraFields,
  ]);
  for (const k of Object.keys(b)) {
    if (!allowed.has(k))
      return fail("unexpected_field", `unexpected field: ${k}`);
  }

  if (b.v !== 1) return fail("bad_version", "v must be 1");
  const strFields = [
    "anonId",
    "pubKey",
    "nonce",
    "signature",
    ...extraFields,
  ] as const;
  for (const f of strFields) {
    const val = b[f];
    if (typeof val !== "string" || !val.length || val.length > 4096) {
      return fail("bad_request", `${f} must be a non-empty string`);
    }
    if (!B64URL.test(val)) return fail("bad_request", `${f} must be base64url`);
  }
  if (!Number.isInteger(b.issuedAt))
    return fail("bad_request", "issuedAt must be an integer (epoch ms)");
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
  const derivedAnonId = bytesToBase64Url(
    new Uint8Array(createHash("sha256").update(rawPub).digest()),
  );
  if (derivedAnonId !== b.anonId)
    return fail("anonid_mismatch", "anonId does not match pubKey");

  let pubKey: webcrypto.CryptoKey;
  try {
    pubKey = await subtle.importKey(
      "raw",
      rawPub,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return fail("bad_pubkey", "pubKey is not a valid P-256 public key");
  }

  // Reconstruct the exact signed payload: all fields except `signature`.
  const payload: Record<string, unknown> = {
    v: 1,
    anonId: b.anonId,
    pubKey: b.pubKey,
    nonce: b.nonce,
    issuedAt: b.issuedAt,
  };
  for (const f of extraFields) payload[f] = b[f];

  const msg = new TextEncoder().encode(canonicalize(payload));
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlToBytes(b.signature as string);
  } catch {
    return fail("bad_signature", "signature is not valid base64url");
  }
  const valid = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pubKey,
    sigBytes,
    msg,
  );
  if (!valid) return fail("bad_signature", "signature verification failed");

  const fields = {} as T;
  for (const f of extraFields) fields[f] = b[f] as T[typeof f];
  return { ok: true, anonId: b.anonId as string, fields };
}

/** Deterministic per-recipient dedupe commitment: SHA-256("refId|anonId"). */
export function redeemerCommit(refId: string, anonId: string): string {
  return createHash("sha256").update(`${refId}|${anonId}`).digest("hex");
}
