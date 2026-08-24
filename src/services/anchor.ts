import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { Logger } from "pino";
import type { Config } from "../config";

const KEYPAIR_FILE = resolve(process.cwd(), ".solana-keypair.json");
const MIN_BALANCE = 0.01 * LAMPORTS_PER_SOL;

// Anchor's instruction discriminator: first 8 bytes of sha256("global:<name>").
function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export interface AnchorResult {
  signature: string;
  cluster: string;
  programId: string;
  recordPda: string;
  nonce: string; // u64 as decimal string (may exceed JS safe int)
  slot?: number;
  explorer: string; // points at the on-chain record account
}

export interface AnchorService {
  readonly cluster: string;
  readonly publicKey: string;
  readonly rpcUrl: string;
  /**
   * Anchor a root. `nonce` (decimal string) selects the record PDA:
   *   - omitted  → a fresh RANDOM nonce, so the record is NOT derivable from the
   *     root (privacy: nobody can locate the anchor knowing only the evidence).
   *   - provided → reuse it, making a re-anchor idempotent. The caller (Foren)
   *     persists the returned nonce and sends it back on subsequent anchors.
   */
  anchorRoot(root: string, nonce?: string): Promise<AnchorResult>;
}

export function resolveRpcUrl(cfg: Config): string {
  if (cfg.SOLANA_RPC_URL) return cfg.SOLANA_RPC_URL;
  if (cfg.SOLANA_CLUSTER === "localnet") return "http://127.0.0.1:8899";
  return clusterApiUrl(cfg.SOLANA_CLUSTER);
}

export function loadOrCreateKeypair(cfg: Config, logger: Logger): Keypair {
  if (cfg.RELAY_SOLANA_SECRET) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(cfg.RELAY_SOLANA_SECRET)));
  }
  if (existsSync(KEYPAIR_FILE)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_FILE, "utf8"))));
  }
  const kp = Keypair.generate();
  writeFileSync(KEYPAIR_FILE, JSON.stringify(Array.from(kp.secretKey)));
  logger.info({ file: KEYPAIR_FILE, pubkey: kp.publicKey.toBase58() }, "generated relay solana keypair");
  return kp;
}

function addressExplorerUrl(address: string, cluster: string): string {
  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/address/${address}${suffix}`;
}

// A fresh, unpredictable u64 nonce. Using a RANDOM (not root-derived) nonce
// means the record PDA cannot be recomputed from the evidence root alone, so an
// anchor is unlinkable to the evidence unless the owner discloses the nonce/PDA.
function randomNonce(): bigint {
  return randomBytes(8).readBigUInt64LE(0);
}

export function buildAnchorService(cfg: Config, logger: Logger): AnchorService {
  const rpcUrl = resolveRpcUrl(cfg);
  const connection = new Connection(rpcUrl, "confirmed");
  const keypair = loadOrCreateKeypair(cfg, logger);
  const cluster = cfg.SOLANA_CLUSTER;
  const programId = new PublicKey(cfg.EVIDENCE_ANCHOR_PROGRAM_ID);

  async function ensureFunded(): Promise<void> {
    const balance = await connection.getBalance(keypair.publicKey);
    if (balance >= MIN_BALANCE) return;
    if (cluster === "mainnet-beta") {
      throw new Error("relay signer is unfunded on mainnet-beta");
    }
    logger.info({ pubkey: keypair.publicKey.toBase58(), cluster }, "requesting airdrop");
    const sig = await connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  return {
    cluster,
    rpcUrl,
    publicKey: keypair.publicKey.toBase58(),

    async anchorRoot(root: string, nonceArg?: string): Promise<AnchorResult> {
      const hash = Buffer.from(root, "hex");
      if (hash.length !== 32) {
        throw new Error("root must be a 32-byte (64 hex char) hash");
      }

      // Reuse the caller's nonce (idempotent re-anchor) or mint a random one.
      const nonce = nonceArg ? BigInt(nonceArg) : randomNonce();
      const nonceLe = Buffer.alloc(8);
      nonceLe.writeBigUInt64LE(nonce);
      const [recordPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("anchor"), keypair.publicKey.toBuffer(), nonceLe],
        programId,
      );

      const base: Omit<AnchorResult, "signature" | "slot"> = {
        cluster,
        programId: programId.toBase58(),
        recordPda: recordPda.toBase58(),
        nonce: nonce.toString(),
        explorer: addressExplorerUrl(recordPda.toBase58(), cluster),
      };

      // Idempotent: if this root is already anchored, the PDA exists — return it
      // rather than paying for (and failing) a duplicate init.
      const existing = await connection.getAccountInfo(recordPda);
      if (existing) {
        const slot = existing.data.readBigUInt64LE(8 + 32 + 32 + 32 + 8);
        return { ...base, signature: "", slot: Number(slot) };
      }

      await ensureFunded();
      // anchor_hash(nonce: u64, hash: [u8;32], location_commitment: [u8;32])
      const data = Buffer.concat([
        discriminator("anchor_hash"),
        nonceLe,
        hash,
        Buffer.alloc(32), // location_commitment: unused by Foren (zeroed)
      ]);
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: recordPda, isSigner: false, isWritable: true },
          { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });
      const tx = new Transaction().add(ix);
      const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
        commitment: "confirmed",
      });
      const status = await connection.getSignatureStatus(signature);
      logger.info({ root: root.slice(0, 12), recordPda: recordPda.toBase58() }, "evidence anchored on-chain");
      return { ...base, signature, slot: status.value?.slot };
    },
  };
}
