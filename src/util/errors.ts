import type { Request, Response, NextFunction } from "express";

/**
 * Errors thrown by routes. The HTTP status is part of the type so that the
 * global error handler can pick it up without tagging each catch-block.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg: string, code = "bad_request") =>
  new HttpError(400, msg, code);
export const unauthorized = (msg = "unauthorized") =>
  new HttpError(401, msg, "unauthorized");
export const tooLarge = (msg = "payload too large") =>
  new HttpError(413, msg, "payload_too_large");
export const unsupported = (msg: string) =>
  new HttpError(415, msg, "unsupported_media_type");
export const internal = (msg = "internal error") =>
  new HttpError(500, msg, "internal");

/** Express global error handler. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  // Unknown error — log via pino-http's attached logger and return 500 without leaking detail.
  // (req as any).log is set by pino-http.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = (req as any).log;
  if (log?.error) log.error({ err }, "unhandled error");
  res.status(500).json({ error: "internal error", code: "internal" });
}
