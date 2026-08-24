/**
 * Emergency dispatcher. Sends pre-encrypted SMS / email payloads to a
 * caller-supplied list of recipients. The recipient address is unavoidably
 * visible to the relay (it has to dial it), but the *message body* is
 * already opaque ciphertext; the relay never sees, never logs, and never
 * persists it.
 *
 * Channel availability is determined at boot from env vars. If a channel is
 * not configured the dispatcher returns a structured failure for that
 * recipient instead of throwing — the user's other channels still go out.
 */
import type { Config } from "../config";
import nodemailer, { type Transporter } from "nodemailer";

export type Channel = "sms" | "email";

export interface Recipient {
  channel: Channel;
  to: string;
}

export interface DispatchPayload {
  /** Already-encrypted ciphertext, typically base64. */
  ciphertext: string;
  /** Optional human-readable subject for email. */
  subject?: string;
}

export interface DispatchResult {
  channel: Channel;
  to_hash: string; // sha256(to).slice(0, 16) — never the raw address
  ok: boolean;
  error?: string;
}

export interface Dispatcher {
  send(recipients: Recipient[], payload: DispatchPayload): Promise<DispatchResult[]>;
  channelsReady(): { sms: boolean; email: boolean };
}

async function hashTo(to: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(to).digest("hex").slice(0, 16);
}

class RealDispatcher implements Dispatcher {
  private smsClient: any | null = null;
  private smtp: Transporter | null = null;
  private smsFrom: string | null = null;
  private emailFrom: string | null = null;

  constructor(cfg: Config) {
    if (cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.TWILIO_FROM) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const twilio = require("twilio");
      this.smsClient = twilio(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN);
      this.smsFrom = cfg.TWILIO_FROM;
    }
    if (cfg.SMTP_URL && cfg.SMTP_FROM) {
      this.smtp = nodemailer.createTransport(cfg.SMTP_URL);
      this.emailFrom = cfg.SMTP_FROM;
    }
  }

  channelsReady() {
    return { sms: !!this.smsClient, email: !!this.smtp };
  }

  async send(recipients: Recipient[], payload: DispatchPayload): Promise<DispatchResult[]> {
    return Promise.all(
      recipients.map(async (r) => {
        const to_hash = await hashTo(r.to);
        try {
          if (r.channel === "sms") {
            if (!this.smsClient || !this.smsFrom) {
              return {
                channel: r.channel,
                to_hash,
                ok: false,
                error: "sms channel not configured",
              };
            }
            await this.smsClient.messages.create({
              from: this.smsFrom,
              to: r.to,
              body: payload.ciphertext,
            });
          } else if (r.channel === "email") {
            if (!this.smtp || !this.emailFrom) {
              return {
                channel: r.channel,
                to_hash,
                ok: false,
                error: "email channel not configured",
              };
            }
            await this.smtp.sendMail({
              from: this.emailFrom,
              to: r.to,
              subject: payload.subject ?? "Prutet alert",
              text: payload.ciphertext,
            });
          }
          return { channel: r.channel, to_hash, ok: true };
        } catch (err) {
          return {
            channel: r.channel,
            to_hash,
            ok: false,
            error: (err as Error).message,
          };
        }
      }),
    );
  }
}

/** In-memory dispatcher used by tests and dev. Records every send. */
export class MemoryDispatcher implements Dispatcher {
  public readonly sent: Array<{ recipient: Recipient; payload: DispatchPayload }> = [];

  channelsReady() {
    return { sms: true, email: true };
  }

  async send(recipients: Recipient[], payload: DispatchPayload): Promise<DispatchResult[]> {
    return Promise.all(
      recipients.map(async (r) => {
        this.sent.push({ recipient: r, payload });
        return { channel: r.channel, to_hash: await hashTo(r.to), ok: true };
      }),
    );
  }
}

export function buildDispatcher(cfg: Config): Dispatcher {
  if (cfg.NODE_ENV === "test") return new MemoryDispatcher();
  return new RealDispatcher(cfg);
}
