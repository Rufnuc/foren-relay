import { Router, type Response } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import type { Config } from "../config";
import type { Payments } from "../services/payments";
import { PaymentError } from "../services/payments/types";
import { getPlan, activePlans } from "../services/payments/plans";
import { badRequest } from "../util/errors";

const CheckoutSchema = z
  .object({
    provider: z.enum(["stripe", "solana-pay"]),
    // Either reference a catalog plan…
    plan: z.string().optional(),
    // …or pass a raw amount + currency (ad-hoc, e.g. donations).
    amount: z.number().int().positive().optional(),
    currency: z.string().min(1).max(10).optional(),
    description: z.string().max(200).optional(),
    successUrl: z.string().url().optional(),
    cancelUrl: z.string().url().optional(),
    metadata: z.record(z.string()).optional(),
  })
  .refine((d) => !!d.plan || (d.amount !== undefined && d.currency !== undefined), {
    message: "provide a plan id, or amount + currency",
  });

function fail(res: Response, err: unknown, next: (e: unknown) => void) {
  if (err instanceof PaymentError) {
    res.status(err.status).json({ error: err.message, code: "payment_error" });
  } else {
    next(err);
  }
}

/**
 * Payment framework routes (pricing/plans intentionally not decided here):
 *   GET  /v1/pay                    — which providers are configured
 *   POST /v1/pay/checkout           — start a payment, returns a URL (Stripe) / solana: URI
 *   GET  /v1/pay/status/:reference  — poll a payment's status
 *   POST /v1/pay/stripe/webhook     — Stripe signed webhook (raw body; see server.ts)
 */
export function paymentsRouter(deps: { cfg: Config; payments: Payments }) {
  const r = Router();
  r.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: deps.cfg.RATE_LIMIT_PAY_PER_MIN,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "rate limited", code: "rate_limited" },
    }),
  );

  r.get("/", (_req, res) => {
    res.json({ providers: deps.payments.providers.map((p) => ({ name: p.name, configured: p.configured })) });
  });

  // The sellable catalog (active plans only). A frontend reads this to render.
  r.get("/plans", (_req, res) => {
    res.json({ plans: activePlans() });
  });

  r.post("/checkout", async (req, res, next) => {
    try {
      const parsed = CheckoutSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      const d = parsed.data;
      const provider = deps.payments.get(d.provider);

      // Resolve a catalog plan → amount/currency (validated first); or use raw amount.
      let amount = d.amount;
      let currency = d.currency;
      let description = d.description;
      let stripePriceId: string | undefined;
      if (d.plan) {
        const plan = getPlan(d.plan);
        if (!plan || !plan.active) throw new PaymentError(`unknown or inactive plan: ${d.plan}`, 400);
        if (!plan.providers.includes(d.provider)) {
          throw new PaymentError(`plan ${plan.id} is not available via ${d.provider}`, 400);
        }
        amount = plan.amount;
        currency = plan.currency;
        description = plan.name;
        stripePriceId = plan.stripePriceId;
      }

      if (!provider.configured) throw new PaymentError(`${provider.name} not configured`, 503);

      const reference = randomUUID();
      const result = await provider.createCheckout({
        reference,
        amount: amount as number,
        currency: currency as string,
        description,
        stripePriceId,
        successUrl: d.successUrl,
        cancelUrl: d.cancelUrl,
        metadata: d.metadata,
      });
      res.json(result);
    } catch (err) {
      fail(res, err, next);
    }
  });

  r.get("/status/:reference", async (req, res, next) => {
    try {
      const name = (req.query.provider as string) ?? "stripe";
      const provider = deps.payments.get(name as "stripe" | "solana-pay");
      const status = await provider.verify(req.params.reference);
      res.json({ reference: req.params.reference, status });
    } catch (err) {
      fail(res, err, next);
    }
  });

  r.post("/stripe/webhook", async (req, res, next) => {
    try {
      const stripe = deps.payments.get("stripe");
      if (!stripe.handleWebhook) throw new PaymentError("no webhook handler", 400);
      // req.body is a Buffer here (raw parser mounted in server.ts).
      const result = await stripe.handleWebhook(req.body as Buffer, req.header("stripe-signature") ?? "");
      // Fulfilment hook: persist result.reference → result.status here.
      res.json({ received: true, result });
    } catch (err) {
      fail(res, err, next);
    }
  });

  return r;
}
