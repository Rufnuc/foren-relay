import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";
import type { Config } from "../config";
import { corsOrigins } from "../config";

/**
 * Stack the standard hardening middleware. CSP is set to deny-by-default —
 * this server only emits JSON; it never serves HTML or scripts.
 */
export function securityMiddleware(cfg: Config): RequestHandler[] {
  const allowed = corsOrigins(cfg);

  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "no-referrer" },
      hsts: cfg.NODE_ENV === "production"
        ? { maxAge: 63072000, includeSubDomains: true, preload: true }
        : false,
    }),
    cors({
      origin: (origin, cb) => {
        // Same-origin or curl/internal: no Origin header → allow.
        if (!origin) return cb(null, true);
        if (allowed.length === 0) {
          return cb(null, false); // explicit allowlist required when given any
        }
        cb(null, allowed.includes(origin));
      },
      methods: ["GET", "POST", "OPTIONS"],
      maxAge: 600,
    }),
  ];
}

export function pinRateLimit(cfg: Config) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: cfg.RATE_LIMIT_PIN_PER_MIN,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate limited", code: "rate_limited" },
  });
}

export function emergencyRateLimit(cfg: Config) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: cfg.RATE_LIMIT_EMERGENCY_PER_MIN,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "rate limited", code: "rate_limited" },
  });
}
