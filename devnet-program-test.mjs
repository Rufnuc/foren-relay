// Fuller devnet lifecycle test for evidence_anchor: anchor_hash → read →
// revoke_anchor → read, plus surface the emitted event. Run from relay/:
//   node devnet-program-test.mjs
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction, clusterApiUrl,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PROGRAM_ID = new PublicKey("8VoTsviK9uW9viwZRXoPcYj47SdKaadchj5kdDfcghYB");
const conn = new Connection(clusterApiUrl("devnet"), "confirmed");
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".solana-keypair.json", "utf8"))));
const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const nonce = BigInt(Date.now());
const nonceLE = Buffer.alloc(8); nonceLE.writeBigUInt64LE(nonce);
const hash = createHash("sha256").update("lifecycle test " + nonce).digest();
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("anchor"), signer.publicKey.toBuffer(), nonceLE], PROGRAM_ID,
);

const readRecord = async () => {
  const info = await conn.getAccountInfo(pda);
  if (!info) return null;
  const b = info.data;
  return { revoked: b[8 + 32 + 32 + 32 + 8 + 8 + 8] === 1 };
};

// 1) anchor_hash
let ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: pda, isSigner: false, isWritable: true },
    { pubkey: signer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc("anchor_hash"), nonceLE, hash, Buffer.alloc(32)]),
});
const sig1 = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer], { commitment: "confirmed" });
console.log("1. anchor_hash  :", sig1);
console.log("   record PDA   :", pda.toBase58(), "| revoked:", (await readRecord()).revoked);

// event log from the anchor tx
const tx = await conn.getTransaction(sig1, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
const evt = (tx?.meta?.logMessages ?? []).find((l) => l.startsWith("Program data:"));
console.log("   emitted event:", evt ? evt.slice(0, 60) + "… (EvidenceAnchored, base64)" : "(none)");

// 2) revoke_anchor
ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: pda, isSigner: false, isWritable: true },
    { pubkey: signer.publicKey, isSigner: true, isWritable: false },
  ],
  data: disc("revoke_anchor"),
});
const sig2 = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer], { commitment: "confirmed" });
console.log("2. revoke_anchor:", sig2);
console.log("   revoked now  :", (await readRecord()).revoked);
console.log("\nexplorer:", `https://explorer.solana.com/address/${pda.toBase58()}?cluster=devnet`);
