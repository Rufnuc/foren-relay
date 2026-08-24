import { Router, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import type { Config } from "../config";
import type { PinningProvider } from "../services/ipfs";
import { badRequest, tooLarge } from "../util/errors";
import { pinRateLimit } from "../middleware/security";

/**
 * POST /v1/pin
 *
 * Two body shapes are accepted:
 *
 *   - multipart/form-data, single file field "blob"
 *   - application/octet-stream, raw body
 *
 * Either way the relay forwards the bytes verbatim to the configured pinning
 * provider. There is no inspection, no decoding, and no persistence.
 */
export function ipfsRouter(deps: { cfg: Config; pinning: PinningProvider }) {
  const r = Router();
  r.use(pinRateLimit(deps.cfg));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.cfg.MAX_BLOB_BYTES, files: 1 },
  });

  const handlePin: RequestHandler = async (req, res, next) => {
    try {
      let blob: Buffer | undefined;
      if (req.file?.buffer) {
        blob = req.file.buffer;
      } else if (Buffer.isBuffer(req.body)) {
        blob = req.body;
      }
      if (!blob || blob.length === 0) {
        throw badRequest("empty body — send raw bytes or multipart `blob` field");
      }
      if (blob.length > deps.cfg.MAX_BLOB_BYTES) {
        throw tooLarge(`blob exceeds ${deps.cfg.MAX_BLOB_BYTES} bytes`);
      }
      const result = await deps.pinning.pin(blob, req.is("application/octet-stream") || undefined);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  r.post(
    "/pin",
    (req, res, next) => {
      // Choose a parser based on content-type. Multer ignores non-multipart bodies.
      if (req.is("multipart/form-data")) return upload.single("blob")(req, res, next);
      return next();
    },
    handlePin,
  );

  const UnpinSchema = z.object({ cid: z.string().min(1) });

  r.post("/unpin", async (req, res, next) => {
    try {
      const parsed = UnpinSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest("body must be { cid: string }");
      await deps.pinning.unpin(parsed.data.cid);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
