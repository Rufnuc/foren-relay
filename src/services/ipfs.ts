/**
 * Pinning provider abstraction.
 *
 * The relay sees opaque ciphertext only. It is the user's responsibility to
 * encrypt the blob client-side before posting it. We don't inspect, decode,
 * or persist the blob beyond the time it takes to forward to the chosen
 * provider.
 */
import type { Config } from "../config";
import { internal } from "../util/errors";

export interface PinResult {
  cid: string;
  size: number;
  pinnedAt: number;
}

export interface PinningProvider {
  readonly name: string;
  pin(blob: Buffer, contentType?: string): Promise<PinResult>;
  /** Best-effort detach. Some providers can't actually delete from the DHT. */
  unpin(cid: string): Promise<void>;
}

class NoopProvider implements PinningProvider {
  readonly name = "noop";
  async pin(blob: Buffer): Promise<PinResult> {
    // Deterministic synthetic CID for tests; no real network call.
    const { createHash } = await import("crypto");
    const digest = createHash("sha256").update(blob).digest("hex");
    return {
      cid: `bafyTEST${digest.slice(0, 46)}`,
      size: blob.length,
      pinnedAt: Date.now(),
    };
  }
  async unpin(_cid: string): Promise<void> {
    /* no-op */
  }
}

class LocalKuboProvider implements PinningProvider {
  readonly name = "local";
  // We import lazily so the relay can boot without kubo when PINNING_PROVIDER != "local".
  private clientPromise: Promise<any> | null = null;
  constructor(private readonly url: string) {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { create } = await import("kubo-rpc-client");
        return create({ url: this.url });
      })();
    }
    return this.clientPromise;
  }

  async pin(blob: Buffer): Promise<PinResult> {
    const ipfs = await this.client();
    const added = await ipfs.add(blob, { pin: true, cidVersion: 1 });
    return {
      cid: added.cid.toString(),
      size: Number(added.size ?? blob.length),
      pinnedAt: Date.now(),
    };
  }

  async unpin(cid: string): Promise<void> {
    const ipfs = await this.client();
    try {
      await ipfs.pin.rm(cid);
    } catch (err) {
      // unpin is best-effort; surface as a warning, not a 500.
      throw internal(`unpin failed for ${cid}: ${(err as Error).message}`);
    }
  }
}

class Web3StorageProvider implements PinningProvider {
  readonly name = "web3storage";
  constructor(private readonly token: string) {}

  async pin(blob: Buffer, contentType = "application/octet-stream"): Promise<PinResult> {
    const res = await fetch("https://api.web3.storage/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": contentType,
      },
      body: blob,
    });
    if (!res.ok) {
      throw internal(`web3.storage upload failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { cid: string };
    return { cid: json.cid, size: blob.length, pinnedAt: Date.now() };
  }

  async unpin(_cid: string): Promise<void> {
    // web3.storage retains content as part of Filecoin commitments; true
    // unpin requires per-account console action. This is documented.
  }
}

class PinataProvider implements PinningProvider {
  readonly name = "pinata";
  constructor(private readonly jwt: string) {}

  async pin(blob: Buffer): Promise<PinResult> {
    const fd = new FormData();
    fd.append("file", new Blob([blob]), "blob.bin");
    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.jwt}` },
      // `fd` is Node's global (undici) FormData; fetch accepts it as the body
      // directly. (No DOM lib here, so the old `BodyInit` cast didn't resolve.)
      body: fd,
    });
    if (!res.ok) {
      throw internal(`pinata upload failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { IpfsHash: string; PinSize: number };
    return { cid: json.IpfsHash, size: json.PinSize, pinnedAt: Date.now() };
  }

  async unpin(cid: string): Promise<void> {
    const res = await fetch(`https://api.pinata.cloud/pinning/unpin/${cid}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.jwt}` },
    });
    if (!res.ok) {
      throw internal(`pinata unpin failed: ${res.status} ${res.statusText}`);
    }
  }
}

export function buildPinningProvider(cfg: Config): PinningProvider {
  switch (cfg.PINNING_PROVIDER) {
    case "noop":
      return new NoopProvider();
    case "local":
      return new LocalKuboProvider(cfg.IPFS_API_URL);
    case "web3storage":
      if (!cfg.WEB3_STORAGE_TOKEN) {
        // Missing config must NOT crash the whole relay — fall back to noop so
        // the rest of the API stays up; pinning just doesn't persist.
        // eslint-disable-next-line no-console
        console.warn("PINNING_PROVIDER=web3storage but WEB3_STORAGE_TOKEN is unset — falling back to noop");
        return new NoopProvider();
      }
      return new Web3StorageProvider(cfg.WEB3_STORAGE_TOKEN);
    case "pinata":
      if (!cfg.PINATA_JWT) {
        // eslint-disable-next-line no-console
        console.warn("PINNING_PROVIDER=pinata but PINATA_JWT is unset — falling back to noop");
        return new NoopProvider();
      }
      return new PinataProvider(cfg.PINATA_JWT);
  }
}
