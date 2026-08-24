import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CheckoutRequest,
  CheckoutResult,
  PaymentProvider,
  PaymentStatus,
  WebhookResult,
} from "./types";
import { PaymentError } from "./types";

// Stripe adapter via the raw REST API (no SDK dependency, so the framework
// compiles with nothing installed). Card data + PCI compliance stay entirely on
// Stripe's hosted Checkout — the relay only ever sees session ids and statuses.

export interface StripeConfig {
  secretKey?: string;
  webhookSecret?: string;
  statementDescriptor: string; // neutral text on the card statement
  successUrl: string;
  cancelUrl: string;
}

const API = "https://api.stripe.com/v1";

function form(obj: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) p.append(k, String(v));
  return p.toString();
}

export function buildStripeProvider(cfg: StripeConfig): PaymentProvider {
  const configured = !!cfg.secretKey;
  // Framework-level ref → session id map. Swap for a DB in production.
  const sessions = new Map<string, string>();

  async function api(path: string, method: "GET" | "POST", body?: string): Promise<any> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new PaymentError((json as any).error?.message ?? "stripe error", 502);
    return json;
  }

  return {
    name: "stripe",
    configured,

    async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
      if (!configured) throw new PaymentError("stripe not configured", 503);
      // A Price id → recurring subscription; otherwise a one-time payment.
      const recurring = !!req.stripePriceId;
      const session = await api(
        "/checkout/sessions",
        "POST",
        form(
          recurring
            ? {
                mode: "subscription",
                "line_items[0][quantity]": 1,
                "line_items[0][price]": req.stripePriceId,
                success_url: req.successUrl ?? cfg.successUrl,
                cancel_url: req.cancelUrl ?? cfg.cancelUrl,
                client_reference_id: req.reference,
                "metadata[reference]": req.reference,
              }
            : {
                mode: "payment",
                "line_items[0][quantity]": 1,
                "line_items[0][price_data][currency]": req.currency,
                "line_items[0][price_data][unit_amount]": req.amount,
                "line_items[0][price_data][product_data][name]": req.description ?? "Payment",
                "payment_intent_data[statement_descriptor]": cfg.statementDescriptor,
                success_url: req.successUrl ?? cfg.successUrl,
                cancel_url: req.cancelUrl ?? cfg.cancelUrl,
                client_reference_id: req.reference,
                "metadata[reference]": req.reference,
              },
        ),
      );
      sessions.set(req.reference, session.id);
      return { provider: "stripe", reference: req.reference, url: session.url };
    },

    async verify(reference: string): Promise<PaymentStatus> {
      if (!configured) throw new PaymentError("stripe not configured", 503);
      const id = sessions.get(reference);
      if (!id) return "pending";
      const s = await api(`/checkout/sessions/${id}`, "GET");
      if (s.payment_status === "paid" || s.payment_status === "no_payment_required") return "confirmed";
      if (s.status === "expired") return "canceled";
      return "pending";
    },

    // Verify the Stripe-Signature header (t=…,v1=…) with the webhook secret.
    async handleWebhook(rawBody: Buffer, signature: string): Promise<WebhookResult | null> {
      if (!cfg.webhookSecret) throw new PaymentError("stripe webhook secret not set", 503);
      const parts = Object.fromEntries(signature.split(",").map((kv) => kv.split("=")));
      const signed = `${parts.t}.${rawBody.toString("utf8")}`;
      const expected = createHmac("sha256", cfg.webhookSecret).update(signed).digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(parts.v1 ?? "");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new PaymentError("invalid stripe signature", 400);
      }
      const event = JSON.parse(rawBody.toString("utf8"));
      const reference = event.data?.object?.client_reference_id;
      if (!reference) return null;
      switch (event.type) {
        case "checkout.session.completed":
          return { reference, status: "confirmed" };
        case "checkout.session.expired":
          return { reference, status: "canceled" };
        case "payment_intent.payment_failed":
          return { reference, status: "failed" };
        default:
          return null;
      }
    },
  };
}
