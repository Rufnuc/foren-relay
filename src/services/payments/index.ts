import type { Config } from "../../config";
import type { PaymentProvider, PaymentProviderName } from "./types";
import { PaymentError } from "./types";
import { buildStripeProvider } from "./stripe";
import { buildSolanaPayProvider } from "./solanaPay";

export interface Payments {
  providers: PaymentProvider[];
  get(name: PaymentProviderName): PaymentProvider;
}

/** Assemble the payment providers from config. Unconfigured ones still exist
 *  (routes return 503 until keys are set) so the framework is always present. */
export function buildPayments(cfg: Config, rpcUrl: string): Payments {
  const stripe = buildStripeProvider({
    secretKey: cfg.STRIPE_SECRET_KEY,
    webhookSecret: cfg.STRIPE_WEBHOOK_SECRET,
    statementDescriptor: cfg.PAYMENT_STATEMENT_DESCRIPTOR,
    successUrl: cfg.PAYMENT_SUCCESS_URL,
    cancelUrl: cfg.PAYMENT_CANCEL_URL,
  });
  const solanaPay = buildSolanaPayProvider({
    recipient: cfg.SOLANA_PAY_RECIPIENT,
    usdcMint: cfg.SOLANA_PAY_USDC_MINT,
    rpcUrl,
  });
  const providers = [stripe, solanaPay];
  return {
    providers,
    get(name) {
      const p = providers.find((x) => x.name === name);
      if (!p) throw new PaymentError(`unknown provider: ${name}`, 400);
      return p;
    },
  };
}

export type { PaymentProvider, PaymentProviderName, PaymentStatus } from "./types";
