import OpenTimestamps from "opentimestamps";
import type { Logger } from "pino";

// Bitcoin anchoring via OpenTimestamps (OTS). Stamping is instant and submits
// the root's hash to public calendar servers, which aggregate and commit to
// Bitcoin within a few hours. The returned `.ots` proof is "pending" until that
// confirmation lands; it can then be upgraded to a full Bitcoin attestation and
// verified independently with any OTS client.

function hashFromHex(rootHex: string): Buffer {
  return Buffer.from(rootHex, "hex");
}

export interface BitcoinStampResult {
  ots: string; // base64 .ots proof
  status: "pending";
}

export interface BitcoinVerifyResult {
  status: "pending" | "confirmed";
  attestedAt?: number; // unix seconds of the Bitcoin block
  height?: number;
  ots?: string; // possibly-upgraded proof (base64)
}

export interface BitcoinAnchorService {
  stamp(rootHex: string): Promise<BitcoinStampResult>;
  verify(rootHex: string, otsB64: string): Promise<BitcoinVerifyResult>;
}

export function buildBitcoinAnchorService(logger: Logger): BitcoinAnchorService {
  return {
    async stamp(rootHex: string): Promise<BitcoinStampResult> {
      const detached = OpenTimestamps.DetachedTimestampFile.fromHash(
        new OpenTimestamps.Ops.OpSHA256(),
        hashFromHex(rootHex),
      );
      await OpenTimestamps.stamp(detached);
      const ots = Buffer.from(detached.serializeToBytes()).toString("base64");
      logger.info({ root: rootHex.slice(0, 12) }, "opentimestamps stamp created");
      return { ots, status: "pending" };
    },

    async verify(rootHex: string, otsB64: string): Promise<BitcoinVerifyResult> {
      const detached = OpenTimestamps.DetachedTimestampFile.deserialize(
        Buffer.from(otsB64, "base64"),
      );
      const fileDetached = OpenTimestamps.DetachedTimestampFile.fromHash(
        new OpenTimestamps.Ops.OpSHA256(),
        hashFromHex(rootHex),
      );
      // Pull any newly-available Bitcoin attestation into the proof.
      try {
        await OpenTimestamps.upgrade(detached);
      } catch {
        /* still pending — ignore */
      }
      const result = await OpenTimestamps.verify(detached, fileDetached);
      const btc = result?.bitcoin ?? (result ? Object.values(result)[0] : undefined);
      const upgradedOts = Buffer.from(detached.serializeToBytes()).toString("base64");

      if (btc?.timestamp) {
        return {
          status: "confirmed",
          attestedAt: btc.timestamp,
          height: btc.height,
          ots: upgradedOts,
        };
      }
      return { status: "pending", ots: upgradedOts };
    },
  };
}
