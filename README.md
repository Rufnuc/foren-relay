# Prutet — Relay

A deliberately small Express server with two responsibilities:

1. **IPFS pin proxy.** Forwards opaque, client-encrypted blobs to a
   configurable pinning provider (`local` Kubo daemon, `web3.storage`,
   `pinata`, or `noop` for tests).
2. **Emergency dispatcher.** Fan-outs a *pre-encrypted* SMS / email payload
   to a caller-supplied recipient list, returning per-recipient status with
   the address hashed.

The relay never sees plaintext evidence, never sees identities, and never
persists anything to disk. Logs are redacted by default.

## Endpoints

| Method | Path                       | Notes                                                 |
| ------ | -------------------------- | ----------------------------------------------------- |
| GET    | `/livez`                   | Liveness — process up.                                |
| GET    | `/readyz`                  | Component status (pinning provider + channel readiness). |
| POST   | `/v1/pin`                  | Pin a blob. Accepts `application/octet-stream` or `multipart/form-data` (`blob` field). |
| POST   | `/v1/unpin`                | Best-effort unpin: `{ "cid": "..." }`.                |
| POST   | `/v1/emergency/dispatch`   | Fan-out an encrypted alert.                           |

### `/v1/emergency/dispatch` body

```json
{
  "recipients": [
    { "channel": "sms",   "to": "+15555550100" },
    { "channel": "email", "to": "ally@example.test" }
  ],
  "payload": {
    "ciphertext": "<base64 ciphertext, ≤8 KB>",
    "subject": "Prutet alert"
  }
}
```

The relay sends `ciphertext` *as-is* in the message body; the recipient must
hold the decryption key out-of-band.

## Configuration

See `.env.example` at the repo root. The relay validates env on boot via
`zod` and exits non-zero with a precise list of issues if anything is
missing.

| Var                       | Default                  |
| ------------------------- | ------------------------ |
| `RELAY_PORT`              | `4000`                   |
| `PINNING_PROVIDER`        | `local`                  |
| `IPFS_API_URL`            | `http://127.0.0.1:5001`  |
| `WEB3_STORAGE_TOKEN`      | (required if `web3storage`) |
| `PINATA_JWT`              | (required if `pinata`)   |
| `TWILIO_*`, `SMTP_*`      | (channels disabled if unset) |
| `MAX_BLOB_BYTES`          | `52428800` (50 MB)       |
| `RATE_LIMIT_PIN_PER_MIN`  | `60`                     |
| `RATE_LIMIT_EMERGENCY_PER_MIN` | `5`                 |

## Running

```bash
yarn workspace @prutet/relay dev      # tsx watch
yarn workspace @prutet/relay build    # tsc to dist/
yarn workspace @prutet/relay start    # node dist/index.js
yarn workspace @prutet/relay test     # vitest + supertest
```

## Threat model

- **Network observer** sees TLS-encrypted traffic only.
- **Relay operator** sees: blob bytes (already encrypted client-side), the
  recipient address (unavoidable for SMS/email delivery), and standard
  request metadata. Logs redact recipient addresses by hashing them on
  ingress; the raw value is held only for the duration of the upstream call.
- **Compromised relay** cannot decrypt evidence or impersonate the user on
  Solana — the relay holds no signing keys and pinning provider tokens, at
  worst, allow an attacker to pin garbage at the project's expense.

## Production hardening checklist (Phase 5)

- [ ] Capability tokens on `/v1/pin` and `/v1/emergency/dispatch`.
- [ ] Per-tenant rate limits (currently per-IP).
- [ ] mTLS between the frontend and the relay if both are self-hosted.
- [ ] Move blob streaming directly to the pinning provider (currently held
      in-memory; the Phase-3 implementation is fine for ≤50 MB blobs but
      would need streaming for large videos).
