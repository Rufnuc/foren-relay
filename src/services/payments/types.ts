// Provider-agnostic payment framework.
//
// Pricing, plans and "who pays for what" are deliberately NOT decided here — this
// is the plumbing. A concrete provider (Stripe for cards, Solana Pay for crypto)
// implements PaymentProvider; the routes and the app talk only to this interface.
//
// Survivor-safety note baked into the design: no customer PII is required to take
// a payment, and card statements use a neutral descriptor (PAYMENT_STATEMENT_
// DESCRIPTOR) so a charge never reveals "Foren" to someone watching an account.

export type PaymentProviderName = "stripe" | "solana-pay";

export type PaymentStatus = "pending" | "confirmed" | "failed" | "canceled";

export interface CheckoutRequest {
  /** Minor units: cents for Stripe (usd), token base units for Solana Pay. */
  amount: number;
  /** "usd" for Stripe; "usdc" | "sol" for Solana Pay. */
  currency: string;
  /** Opaque id the caller generates to track this payment end-to-end. */
  reference: string;
  description?: string;
  /** Stripe recurring: a Price id → subscription checkout (overrides amount). */
  stripePriceId?: string;
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, string>;
}

export interface CheckoutResult {
  provider: PaymentProviderName;
  reference: string;
  /** Stripe: hosted Checkout URL to redirect to. Solana Pay: a solana: URL for a QR. */
  url: string;
  extra?: Record<string, unknown>;
}

export interface WebhookResult {
  reference: string;
  status: PaymentStatus;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** False until the required keys/config are present; routes 503 when false. */
  readonly configured: boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  /** Poll the current status of a payment by its reference. */
  verify(reference: string): Promise<PaymentStatus>;
  /** Card providers verify signed webhooks; crypto providers poll and omit this. */
  handleWebhook?(rawBody: Buffer, signature: string): Promise<WebhookResult | null>;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}
