import type { PaymentProviderName } from "./types";

// Pricing catalog. This is the ONE place to define what can be sold; the routes
// resolve a `plan` id to an amount/currency at checkout. Everything here is a
// PLACEHOLDER — edit freely. Nothing is ever charged until real provider keys are
// set, and recurring plans stay inactive until their Stripe Price ids are filled.

export type PlanInterval = "one_time" | "month" | "year";

export interface PricingPlan {
  id: string;
  name: string;
  description: string;
  interval: PlanInterval;
  /** Minor units: cents for usd, token base units for usdc/sol. */
  amount: number;
  currency: string; // "usd" | "usdc" | "sol"
  providers: PaymentProviderName[];
  /** Required for recurring Stripe plans: create the Price in Stripe, paste its id. */
  stripePriceId?: string;
  features?: string[];
  /** Recurring plans start inactive until stripePriceId is set. */
  active: boolean;
}

export const PLANS: PricingPlan[] = [
  {
    id: "supporter-once",
    name: "Supporter (one-time)",
    description: "One-off contribution to keep Foren free for survivors.",
    interval: "one_time",
    amount: 1000, // $10.00
    currency: "usd",
    providers: ["stripe", "solana-pay"],
    features: ["Supports free access for survivors"],
    active: true,
  },
  {
    id: "supporter-usdc",
    name: "Supporter (USDC)",
    description: "One-off crypto contribution via Solana Pay.",
    interval: "one_time",
    amount: 10_000000, // 10 USDC (6 decimals)
    currency: "usdc",
    providers: ["solana-pay"],
    active: true,
  },
  {
    id: "pro-monthly",
    name: "Professional (monthly)",
    description: "For advocates, DV services and law firms. Survivors always use Foren free.",
    interval: "month",
    amount: 2900, // $29.00 / month
    currency: "usd",
    providers: ["stripe"],
    stripePriceId: "price_REPLACE_ME", // create a monthly Price in Stripe, paste id, set active
    features: ["Team access", "Priority support"],
    active: false,
  },
  {
    id: "pro-yearly",
    name: "Professional (yearly)",
    description: "Annual professional licence (2 months free vs monthly).",
    interval: "year",
    amount: 29000, // $290.00 / year
    currency: "usd",
    providers: ["stripe"],
    stripePriceId: "price_REPLACE_ME",
    active: false,
  },
];

export function getPlan(id: string): PricingPlan | undefined {
  return PLANS.find((p) => p.id === id);
}

export function activePlans(): PricingPlan[] {
  return PLANS.filter((p) => p.active);
}
