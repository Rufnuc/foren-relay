import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type {
  CheckoutRequest,
  CheckoutResult,
  PaymentProvider,
  PaymentStatus,
} from "./types";
import { PaymentError } from "./types";

// Solana Pay adapter. Builds a `solana:` transfer-request URL (render it as a QR
// in the app) and verifies by finding an on-chain transaction that carries the
// unique `reference` public key. Crypto is pull-based, so there is no webhook —
// the app polls verify().
//
// NOTE (production): verify() here confirms a referenced transaction landed; a
// hardened version should use Solana Pay's validateTransfer to also check the
// exact amount + recipient. Kept simple for the framework.

export interface SolanaPayConfig {
  recipient?: string; // base58 pubkey that receives funds
  usdcMint?: string; // SPL mint for USDC payments (omit for native SOL)
  rpcUrl: string;
}

// decimals per currency, to convert our base-unit amount → Solana Pay decimal amount
const DECIMALS: Record<string, number> = { sol: 9, usdc: 6 };

export function buildSolanaPayProvider(cfg: SolanaPayConfig): PaymentProvider {
  const configured = !!cfg.recipient;
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const refs = new Map<string, PublicKey>(); // our reference → on-chain reference pubkey

  return {
    name: "solana-pay",
    configured,

    async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
      if (!configured) throw new PaymentError("solana-pay not configured", 503);
      const referenceKey = Keypair.generate().publicKey; // unique on-chain marker
      refs.set(req.reference, referenceKey);

      const decimals = DECIMALS[req.currency.toLowerCase()] ?? 0;
      const amount = (req.amount / 10 ** decimals).toString();

      const p = new URLSearchParams();
      p.set("amount", amount);
      p.set("reference", referenceKey.toBase58());
      if (req.currency.toLowerCase() === "usdc" && cfg.usdcMint) p.set("spl-token", cfg.usdcMint);
      p.set("label", "Foren");
      if (req.description) p.set("message", req.description);

      return {
        provider: "solana-pay",
        reference: req.reference,
        url: `solana:${cfg.recipient}?${p.toString()}`,
        extra: { onchainReference: referenceKey.toBase58() },
      };
    },

    async verify(reference: string): Promise<PaymentStatus> {
      if (!configured) throw new PaymentError("solana-pay not configured", 503);
      const refKey = refs.get(reference);
      if (!refKey) return "pending";
      const sigs = await connection.getSignaturesForAddress(refKey, { limit: 5 });
      const landed = sigs.find((s) => s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");
      if (!landed) return "pending";
      return landed.err ? "failed" : "confirmed";
    },
  };
}
