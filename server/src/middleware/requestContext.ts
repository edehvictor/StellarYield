import { NextFunction, Request, Response } from "express";
import crypto from "crypto";

export const REQUEST_ID_HEADER = "x-request-id";

function normalizeRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  return trimmed;
}

export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const forwarded = normalizeRequestId(req.header(REQUEST_ID_HEADER));
  const requestId = forwarded ?? crypto.randomUUID();

  (req as unknown as { requestId: string }).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  next();
}

