import { NextFunction, Request, Response } from "express";
import crypto from "crypto";

export const CORRELATION_ID_HEADER = "x-correlation-id";
export const REQUEST_ID_HEADER = "x-request-id";

// Validates that an inbound ID is a non-empty string within acceptable bounds.
function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  return trimmed;
}

/**
 * Attaches correlation and request IDs to every request.
 *
 * Propagation rules:
 *  - X-Correlation-ID: forwarded from the client when present and valid;
 *    otherwise a fresh UUID is generated.
 *  - X-Request-ID: always generated fresh for each hop so individual
 *    service legs can be distinguished within the same correlation trace.
 *
 * Both IDs are echoed back in the response headers and written onto `req`
 * so that downstream middleware and route handlers can include them in logs.
 */
export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inboundCorrelationId = normalizeId(req.header(CORRELATION_ID_HEADER));
  const correlationId = inboundCorrelationId ?? crypto.randomUUID();
  const requestId = crypto.randomUUID();

  const ctx = req as unknown as {
    correlationId: string;
    requestId: string;
  };
  ctx.correlationId = correlationId;
  ctx.requestId = requestId;

  res.setHeader("X-Correlation-Id", correlationId);
  res.setHeader("X-Request-Id", requestId);

  next();
}

/** Retrieve the correlation ID attached by correlationIdMiddleware. */
export function getCorrelationId(req: Request): string | undefined {
  return (req as unknown as { correlationId?: string }).correlationId;
}

/** Retrieve the per-hop request ID attached by correlationIdMiddleware. */
export function getRequestId(req: Request): string | undefined {
  return (req as unknown as { requestId?: string }).requestId;
}
