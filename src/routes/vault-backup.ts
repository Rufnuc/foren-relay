import { Router } from "express";
import rateLimit from "express-rate-limit";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "../config";
import type { UsageService } from "../services/usage";
import type { PinningProvider } from "../services/ipfs";
import { badRequest, tooLarge } from "../util/errors";

/**
 * Hosted, zero-knowledge vault backup.
 *
 *   PUT    /v1/vault-backup/:locator   header x-write-secret, body = E2E-encrypted blob
 *   GET    /v1/vault-backup/:locator   → the encrypted blob (opaque)
 *   DELETE /v1/vault-backup/:locator   header x-write-secret
 *
 * The relay stores only an opaque locator, a write commitment (a HASH of the
 * code-derived write secret), and the IPFS CID. It never sees plaintext, an
 * identity, or the key. `locator` and the write secret are both derived from the
 * user's Backup Code; the blob is encrypted under that same code client-side.
 */
const LOCATOR = /^[A-Za-z0-9_-]{16,128}$/;
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

function secretMatches(presented: string, commit: string): boolean {
  const a = Buffer.from(sha256hex(presented));
  const b = Buffer.from(commit);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function vaultBackupRouter(deps: { cfg: Config; usage: UsageService; pinning: PinningProvider }) {
  const r = Router();
  r.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: deps.cfg.RATE_LIMIT_BACKUP_PER_MIN,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "rate limited", code: "rate_limited" },
    }),
  );

  const store = deps.usage.store;

  // PUT — create or replace this locator's backup. First write registers the
  // write commitment; later writes must present the matching secret.
  r.put("/:locator", async (req, res, next) => {
    try {
      const locator = req.params.locator;
      if (!LOCATOR.test(locator)) throw badRequest("bad locator");
      const secret = req.get("x-write-secret") ?? "";
      if (!secret) throw badRequest("missing x-write-secret");
      const blob = Buffer.isBuffer(req.body) ? req.body : undefined;
      if (!blob || blob.length === 0) throw badRequest("empty body — send the encrypted blob as raw bytes");
      if (blob.length > deps.cfg.VAULT_BACKUP_MAX_BYTES) {
        throw tooLarge(`backup exceeds ${deps.cfg.VAULT_BACKUP_MAX_BYTES} bytes`);
      }

      const existing = await store.getBackup(locator);
      if (existing && !secretMatches(secret, existing.writeCommit)) {
        return res.status(403).json({ error: "not authorized for this locator", code: "forbidden" });
      }

      const pinned = await deps.pinning.pin(blob, "application/octet-stream");
      const now = Date.now();
      await store.putBackup({
        locator,
        writeCommit: existing ? existing.writeCommit : sha256hex(secret),
        cid: pinned.cid,
        size: pinned.size,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
      });
      // Best-effort: detach the previous blob so we don't accumulate versions.
      if (existing && existing.cid !== pinned.cid) {
        deps.pinning.unpin(existing.cid).catch(() => {});
      }
      res.json({ ok: true, cid: pinned.cid, size: pinned.size });
    } catch (err) {
      next(err);
    }
  });

  // GET — return the opaque encrypted blob. No auth: it's ciphertext, and the
  // locator is unguessable (a hash of the high-entropy code).
  r.get("/:locator", async (req, res, next) => {
    try {
      const locator = req.params.locator;
      if (!LOCATOR.test(locator)) throw badRequest("bad locator");
      const row = await store.getBackup(locator);
      if (!row) return res.status(404).json({ error: "no backup at that locator", code: "not_found" });
      const blob = await deps.pinning.cat(row.cid);
      res.setHeader("content-type", "application/octet-stream");
      res.send(blob);
    } catch (err) {
      next(err);
    }
  });

  // DELETE — remove a backup (panic). Requires the write secret.
  r.delete("/:locator", async (req, res, next) => {
    try {
      const locator = req.params.locator;
      if (!LOCATOR.test(locator)) throw badRequest("bad locator");
      const row = await store.getBackup(locator);
      if (!row) return res.status(404).json({ error: "no backup at that locator", code: "not_found" });
      const secret = req.get("x-write-secret") ?? "";
      if (!secretMatches(secret, row.writeCommit)) {
        return res.status(403).json({ error: "not authorized for this locator", code: "forbidden" });
      }
      deps.pinning.unpin(row.cid).catch(() => {});
      await store.deleteBackup(locator);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
