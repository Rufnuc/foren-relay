// Devnet smoke test for the evidence_anchor program: call anchor_hash, then read
// the created PDA record back off-chain. Run from the relay dir (has @solana/web3.js):
//   node devnet-anchor-test.mjs
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction, clusterApiUrl,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PROGRAM_ID = new PublicKey("8VoTsviK9uW9viwZRXoPcYj47SdKaadchj5kdDfcghYB");
const conn = new Connection(clusterApiUrl("devnet"), "confirmed");
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".solana-keypair.json", "utf8"))));

// Anchor instruction discriminator = sha256("global:<name>")[0..8]
const disc = createHash("sha256").update("global:anchor_hash").digest().subarray(0, 8);

const nonce = BigInt(Date.now());
const nonceLE = Buffer.alloc(8); nonceLE.writeBigUInt64LE(nonce);
const hash = createHash("sha256").update("foren evidence root " + nonce).digest(); // 32 bytes
const location = Buffer.alloc(32); // no location commitment

const [recordPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("anchor"), signer.publicKey.toBuffer(), nonceLE], PROGRAM_ID,
);

const data = Buffer.concat([disc, nonceLE, hash, location]); // args: nonce, hash[32], location[32]
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: recordPda, isSigner: false, isWritable: true },
    { pubkey: signer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});

const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer], { commitment: "confirmed" });
console.log("anchor_hash tx :", sig);
console.log("tx explorer    :", `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
console.log("record PDA     :", recordPda.toBase58());
console.log("PDA explorer   :", `https://explorer.solana.com/address/${recordPda.toBase58()}?cluster=devnet`);

// Read the account back and decode AnchorRecord.
const info = await conn.getAccountInfo(recordPda);
const b = info.data; let o = 8; // skip 8-byte account discriminator
const owner = new PublicKey(b.subarray(o, o + 32)); o += 32;
const storedHash = b.subarray(o, o + 32).toString("hex"); o += 32;
o += 32; // location_commitment
const timestamp = b.readBigInt64LE(o); o += 8;
const slot = b.readBigUInt64LE(o); o += 8;
const storedNonce = b.readBigUInt64LE(o);
console.log("\n--- on-chain record ---");
console.log("owner    :", owner.toBase58());
console.log("hash     :", storedHash);
console.log("matches  :", storedHash === hash.toString("hex"));
console.log("slot     :", slot.toString(), "| unix ts:", timestamp.toString(), "| nonce:", storedNonce.toString());
