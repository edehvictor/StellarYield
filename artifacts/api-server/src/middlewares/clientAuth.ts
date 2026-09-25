import type { NextFunction, Request, Response } from "express";
import { CancelTransactionIntentHeader } from "@workspace/api-zod";
import { ApiError } from "../lib/errors";

/**
 * Header carrying the client identifier a request acts on behalf of.
 * Matches the `x-client-id` parameter declared in the OpenAPI contract.
 */
export const CLIENT_ID_HEADER = "x-client-id";

/** `res.locals` slot the validated client identifier is stored in. */
const CLIENT_ID_LOCALE_KEY = "clientId";

/**
 * Strict route auth filter: every request travelling through this middleware
 * must carry a well-formed client identifier in the `x-client-id` header.
 *
 * - Missing or blank headers are rejected with `MISSING_CLIENT_IDENTIFIER`.
 * - Headers failing the contract pattern (length/charset) are rejected with
 *   `INVALID_CLIENT_IDENTIFIER`.
 *
 * On success the validated identifier is stored on `res.locals` where the
 * route handler reads it via {@link getClientId}. No intent state is read or
 * written before this filter passes.
 */
export function requireClientId(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const raw = req.headers[CLIENT_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (value === undefined || value.trim() === "") {
    next(ApiError.missingClientIdentifier());
    return;
  }

  const parsed = CancelTransactionIntentHeader.safeParse({
    [CLIENT_ID_HEADER]: value,
  });

  if (!parsed.success) {
    next(ApiError.invalidClientIdentifier());
    return;
  }

  res.locals[CLIENT_ID_LOCALE_KEY] = parsed.data[CLIENT_ID_HEADER];
  next();
}

/**
 * Reads the client identifier validated by {@link requireClientId}.
 * Throws a typed 401 if the auth filter never ran — a route wiring bug can
 * never silently skip identity enforcement.
 */
export function getClientId(res: Response): string {
  const clientId: unknown = res.locals[CLIENT_ID_LOCALE_KEY];

  if (typeof clientId !== "string" || clientId === "") {
    throw ApiError.missingClientIdentifier();
  }

  return clientId;
}
