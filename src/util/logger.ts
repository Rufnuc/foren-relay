import pino, { type Logger } from "pino";
import type { Config } from "../config";

/**
 * Pino logger that *redacts* anything that could be PII or evidence content.
 * The relay must never persist these in plaintext, and structured logs are
 * the most common accidental leak path.
 */
export function buildLogger(cfg: Pick<Config, "LOG_LEVEL" | "NODE_ENV">): Logger {
  return pino({
    level: cfg.LOG_LEVEL,
    transport:
      cfg.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
        "req.body.recipients",
        "req.body.payload",
        "req.body.ciphertext",
        "res.body.cid",
        "*.to",
        "*.email",
        "*.phone",
        "*.recipient",
      ],
      censor: "[REDACTED]",
    },
    base: { service: "prutet-relay" },
  });
}
