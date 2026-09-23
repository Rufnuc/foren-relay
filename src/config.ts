/**
 * Centralised env parsing. Validates with zod so a misconfiguration fails
 * loudly at boot rather than mid-request.
 */
import "dotenv/config";
import { z } from "zod";

const PinningProvider = z.enum(["local", "web3storage", "pinata", "noop"]);
export type PinningProvider = z.infer<typeof PinningProvider>;

const Schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Hosts like Render/Railway assign the port via $PORT; honour it, else 4000.
  RELAY_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(Number(process.env.PORT) || 4000),
  RELAY_HOST: z.string().default("0.0.0.0"),

  // CORS — comma-separated list. Empty = same-origin only.
  CORS_ORIGINS: z.string().default(""),

  // Maximum size of an encrypted blob accepted by /v1/pin (bytes).
  MAX_BLOB_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),

  // IPFS pinning
  PINNING_PROVIDER: PinningProvider.default("local"),
  IPFS_API_URL: z.string().url().default("http://127.0.0.1:5001"),
  WEB3_STORAGE_TOKEN: z.string().optional(),
  PINATA_JWT: z.string().optional(),

  // Emergency dispatch (any of the channels may be omitted in dev)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  // Rate limits (per IP, per window)
  RATE_LIMIT_PIN_PER_MIN: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_EMERGENCY_PER_MIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_ANCHOR_PER_MIN: z.coerce.number().int().positive().default(10),

  // Solana anchoring
  SOLANA_CLUSTER: z.enum(["localnet", "devnet", "mainnet-beta"]).default("devnet"),
  // Optional explicit RPC override; otherwise derived from the cluster.
  SOLANA_RPC_URL: z.string().url().optional(),
  // Relay signing key as a JSON array of 64 bytes (solana-keygen format). If
  // omitted, a throwaway key is generated and persisted next to the relay.
  RELAY_SOLANA_SECRET: z.string().optional(),
  // The deployed `evidence_anchor` program. Anchoring writes a PDA record
  // (hash + slot + timestamp) instead of a plain SPL Memo, so the on-chain
  // commitment is structured, queryable, and independently verifiable.
  EVIDENCE_ANCHOR_PROGRAM_ID: z
    .string()
    .default("8VoTsviK9uW9viwZRXoPcYj47SdKaadchj5kdDfcghYB"),
  // The deployed Groth16 `zk_verifier` program. The relay can relay a
  // client-generated proof to it for trustless on-chain verification.
  ZK_VERIFIER_PROGRAM_ID: z
    .string()
    .default("Hm5unJFLi9SA8P8vrQWWy3YgfyX21UQGZafpnpedJsT1"),

  // Payments (framework — all optional; a provider stays "unconfigured" until set).
  RATE_LIMIT_PAY_PER_MIN: z.coerce.number().int().positive().default(20),
  // Stripe (cards). Card data never touches the relay — hosted Checkout only.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Neutral text on the card statement (survivor safety — never reveals "Foren").
  PAYMENT_STATEMENT_DESCRIPTOR: z.string().max(22).default("SUPPORT"),
  PAYMENT_SUCCESS_URL: z.string().url().default("https://foren.app/pay/success"),
  PAYMENT_CANCEL_URL: z.string().url().default("https://foren.app/pay/cancel"),
  // Solana Pay (crypto). Recipient pubkey + optional SPL mint for USDC.
  SOLANA_PAY_RECIPIENT: z.string().optional(),
  SOLANA_PAY_USDC_MINT: z.string().optional(),

  // Anonymous usage tracking (privacy-preserving; counts only). Disabled means
  // the /v1/usage routes are not mounted at all.
  USAGE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // SQLite database file. On ephemeral hosts (Render free tier) mount a
  // persistent disk and point this at it, or weekly data resets on redeploy.
  USAGE_DB_PATH: z.string().default("./data/usage.db"),
  // How far a submission's issuedAt may be from server time (replay freshness).
  USAGE_MAX_SKEW_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  // How long replay nonces are retained (>= max skew). Older nonces are pruned.
  USAGE_NONCE_RETENTION_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  RATE_LIMIT_USAGE_PER_MIN: z.coerce.number().int().positive().default(30),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    // Print the issues clearly and exit. A relay with bad config is a foot-gun.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid relay configuration:\n${issues}`);
  }
  return parsed.data;
}

export function corsOrigins(cfg: Config): string[] {
  return cfg.CORS_ORIGINS
    ? cfg.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
}
