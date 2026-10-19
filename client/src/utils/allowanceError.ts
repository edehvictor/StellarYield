/**
 * Client adapter for typed token-allowance failures (#1395).
 *
 * The server and client allowance checks resolve to a `TokenAllowanceError`
 * (see `shared/types/tokenAllowance.ts`). This module renders that typed result
 * into the `DecodedError` shape consumed by `TransactionFailedModal`, so a
 * failed allowance check produces the same deterministic UI as a failed
 * contract call — no parsing of raw provider output.
 */

import type { TokenAllowanceError } from "../../../shared/types/tokenAllowance";
import type { DecodedError } from "./errorDecoder";

/** Narrow an unknown value to a `TokenAllowanceError`-shaped object. */
export function isTokenAllowanceError(value: unknown): value is TokenAllowanceError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TokenAllowanceError>;
  return (
    typeof candidate.code === "string" &&
    candidate.code.startsWith("ALLOWANCE_") &&
    typeof candidate.title === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.remediation === "string"
  );
}

/** Stable, non-sensitive serialization used as the modal's developer log. */
export function serializeAllowanceError(error: TokenAllowanceError): string {
  const lines = [`code=${error.code}`, `retryable=${error.retryable}`];
  if (error.required !== undefined) lines.push(`required=${error.required.toString()}`);
  if (error.available !== undefined) lines.push(`available=${error.available.toString()}`);
  if (error.shortfall !== undefined) lines.push(`shortfall=${error.shortfall.toString()}`);
  if (error.panic?.errorName) lines.push(`contractError=${error.panic.errorName}`);
  return lines.join("\n");
}

/**
 * Human-readable shortfall description for the allowance banner, or `null` when
 * the amounts are unknown or the allowance is not actually short.
 */
export function describeAllowanceShortfall(error: TokenAllowanceError): string | null {
  if (error.required === undefined || error.available === undefined) return null;
  const shortfall = error.shortfall ?? 0n;
  if (shortfall <= 0n) return null;
  return `Approved ${error.available.toString()} of ${error.required.toString()} required (short by ${shortfall.toString()}).`;
}

/**
 * Convert a typed allowance error into the `DecodedError` the transaction
 * failure modal expects.
 */
export function toDecodedError(error: TokenAllowanceError): DecodedError {
  const shortfall = describeAllowanceShortfall(error);
  return {
    title: error.title,
    message: error.message,
    suggestion: shortfall ? `${error.remediation} ${shortfall}` : error.remediation,
    raw: serializeAllowanceError(error),
  };
}
