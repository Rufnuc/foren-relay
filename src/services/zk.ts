import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { Logger } from "pino";
import type { Config } from "../config";
import { loadOrCreateKeypair, resolveRpcUrl } from "./anchor";

// Relays a client-generated Groth16 proof to the on-chain `zk_verifier`. The
// prover keeps the private witness (evidence hash, exact lat/lon, salt) on the
// device; only the proof and the public inputs (slot range + commitments) ever
// reach the relay, which submits them to the deployed verifier. A transaction
// that lands proves the pairing check passed on-chain; a rejected proof throws.
//
// Public inputs, in circuit declaration order:
//   [slot_min, slot_max, location_commitment, nullifier]

const PUBLIC_INPUT_SCHEMA = ["slot_min", "slot_max", "location_commitment", "nullifier"];

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

// 32-byte big-endian encoding of a decimal Fr element (accepts hex too).
function feToBytes(value: string): Buffer {
  const v = value.startsWith("0x") ? BigInt(value) : BigInt(value);
  const hex = v.toString(16);
  if (hex.length > 64) throw new Error("public input exceeds 32 bytes");
  return Buffer.from(hex.padStart(64, "0"), "hex");
}

function hexTo(len: number, hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const b = Buffer.from(clean, "hex");
  if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
  return b;
}

export interface ZkVerifyRequest {
  proof_a: string; // 64-byte hex
  proof_b: string; // 128-byte hex
  proof_c: string; // 64-byte hex
  public_inputs: string[]; // decimal (or hex) Fr elements, circuit order
}

export interface ZkVerifyResult {
  verified: boolean;
  signature?: string;
  cluster: string;
  programId: string;
  vkAccount: string;
  reason?: string;
}

export interface ZkService {
  readonly programId: string;
  readonly vkAccount: string;
  readonly publicInputSchema: string[];
  verifyOnChain(req: ZkVerifyRequest): Promise<ZkVerifyResult>;
}

export function buildZkService(cfg: Config, logger: Logger): ZkService {
  const connection = new Connection(resolveRpcUrl(cfg), "confirmed");
  const keypair: Keypair = loadOrCreateKeypair(cfg, logger);
  const programId = new PublicKey(cfg.ZK_VERIFIER_PROGRAM_ID);
  // The verifying key was initialised under the relay's own authority.
  const [vkPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vk"), keypair.publicKey.toBuffer()],
    programId,
  );

  return {
    programId: programId.toBase58(),
    vkAccount: vkPda.toBase58(),
    publicInputSchema: PUBLIC_INPUT_SCHEMA,

    async verifyOnChain(req: ZkVerifyRequest): Promise<ZkVerifyResult> {
      const base = {
        cluster: cfg.SOLANA_CLUSTER,
        programId: programId.toBase58(),
        vkAccount: vkPda.toBase58(),
      };

      const vk = await connection.getAccountInfo(vkPda);
      if (!vk) {
        return { ...base, verified: false, reason: "verifying key not initialised on-chain" };
      }

      const proofA = hexTo(64, req.proof_a);
      const proofB = hexTo(128, req.proof_b);
      const proofC = hexTo(64, req.proof_c);
      const pubs = req.public_inputs.map(feToBytes);
      const pubLen = Buffer.alloc(4);
      pubLen.writeUInt32LE(pubs.length);

      const data = Buffer.concat([
        discriminator("verify_proof"),
        proofA,
        proofB,
        proofC,
        pubLen,
        ...pubs,
      ]);
      const ix = new TransactionInstruction({
        programId,
        keys: [{ pubkey: vkPda, isSigner: false, isWritable: false }],
        data,
      });

      try {
        const signature = await sendAndConfirmTransaction(
          connection,
          new Transaction().add(ix),
          [keypair],
          { commitment: "confirmed" },
        );
        logger.info({ signature }, "zk proof verified on-chain");
        return { ...base, verified: true, signature };
      } catch (err) {
        // The verifier throws ProofInvalid / AltBn128Failed for a bad proof.
        return { ...base, verified: false, reason: (err as Error).message };
      }
    },
  };
}
