import type { NextFunction, Request, Response } from "express";
import { AccountLinkError } from "../lib/errors";
import {
  STELLAR_PUBLIC_KEY_REJECTION_MESSAGES,
  parseStellarPublicKey,
} from "../lib/stellarPublicKey";

/** Body field carrying the user-supplied Stellar public key. */
export const PUBLIC_KEY_BODY_FIELD = "publicKey";

/** `res.locals` slot the validated public key is stored in. */
const PUBLIC_KEY_LOCALE_KEY = "stellarPublicKey";

const MISSING_REJECTIONS = new Set(["MISSING", "EMPTY"]);

/**
 * Controller input filter that traps malformed Stellar public keys before
 * any downstream application or database processing occurs.
 *
 * - Absent, `null`, or blank `publicKey` fields are rejected with a typed
 *   400 `MISSING_PUBLIC_KEY`.
 * - Non-string or malformed keys (wrong prefix, invalid length,
 *   non-alphanumeric input, checksum failure) are rejected with a typed 400
 *   `INVALID_PUBLIC_KEY` carrying a stable per-reason detail message.
 *
 * On success the normalized (trimmed) key is stored on `res.locals` where
 * the route handler reads it via {@link getValidatedStellarPublicKey}, so
 * the application only ever processes StrKey-validated keys.
 */
export function requireValidStellarPublicKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body: unknown = req.body;
  const fieldValue: unknown =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)[PUBLIC_KEY_BODY_FIELD]
      : undefined;

  const result = parseStellarPublicKey(fieldValue);

  if (result.ok) {
    res.locals[PUBLIC_KEY_LOCALE_KEY] = result.publicKey;
    next();
    return;
  }

  if (MISSING_REJECTIONS.has(result.rejection)) {
    next(AccountLinkError.missingPublicKey());
    return;
  }

  next(
    AccountLinkError.invalidPublicKey(
      STELLAR_PUBLIC_KEY_REJECTION_MESSAGES[result.rejection],
    ),
  );
}

/**
 * Reads the validated public key produced by
 * {@link requireValidStellarPublicKey}. Throws a typed 400 if the filter
 * never ran - a route wiring bug can never skip key validation.
 */
export function getValidatedStellarPublicKey(res: Response): string {
  const publicKey: unknown = res.locals[PUBLIC_KEY_LOCALE_KEY];

  if (typeof publicKey !== "string" || publicKey === "") {
    throw AccountLinkError.missingPublicKey();
  }

  return publicKey;
}
