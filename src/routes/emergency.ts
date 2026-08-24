import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config";
import type { Dispatcher } from "../services/dispatch";
import { badRequest } from "../util/errors";
import { emergencyRateLimit } from "../middleware/security";

const Channel = z.enum(["sms", "email"]);
const RecipientSchema = z.object({
  channel: Channel,
  to: z.string().min(3).max(254),
});
const DispatchSchema = z.object({
  recipients: z.array(RecipientSchema).min(1).max(20),
  payload: z.object({
    ciphertext: z.string().min(1).max(8 * 1024), // 8 KB cap
    subject: z.string().max(120).optional(),
  }),
});

/**
 * POST /v1/emergency/dispatch
 *
 * Accepts a recipient list and a pre-encrypted message body. Fan-outs over
 * the configured channels and returns a per-recipient status with the raw
 * `to` field hashed (sha256, 16-hex prefix) so it never appears in logs or
 * responses.
 */
export function emergencyRouter(deps: { cfg: Config; dispatcher: Dispatcher }) {
  const r = Router();
  r.use(emergencyRateLimit(deps.cfg));

  r.post("/dispatch", async (req, res, next) => {
    try {
      const parsed = DispatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        );
      }
      const results = await deps.dispatcher.send(
        parsed.data.recipients,
        parsed.data.payload,
      );
      const failures = results.filter((r) => !r.ok);
      res.status(failures.length === 0 ? 200 : 207).json({
        dispatched: results.filter((r) => r.ok).length,
        failures,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
