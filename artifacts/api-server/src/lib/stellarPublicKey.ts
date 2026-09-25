import { StrKey } from "@stellar/stellar-sdk";

/**
 * Machine-readable reason a candidate value was rejected as a Stellar
 * public key. Every value maps to a stable, human-readable message - raw
 * SDK or provider output is never surfaced to callers.
 */
export type StellarPublicKeyRejection =
  | "MISSING"
  | "EMPTY"
  | "NOT_A_STRING"
  | "INVALID_LENGTH"
  | "INVALID_PREFIX"
  | "INVALID_CHARACTERS"
  | "STRKEY_DECODE_FAILED";

export type ParseStellarPublicKeyResult =
  | { readonly ok: true; readonly publicKey: string }
  | { readonly ok: false; readonly rejection: StellarPublicKeyRejection };

/** Expected length of a G-prefixed ed25519 public key (1 prefix + 55 chars). */
export const STELLAR_PUBLIC_KEY_LENGTH = 56;

/** Base32 alphabet used by StrKey encoding: A-Z and 2-7. */
const BASE32_PATTERN = /^[A-Z2-7]+$/;

/**
 * Stable detail message for each rejection reason. These strings are part of
 * the typed error contract and must never contain provider or SDK output.
 */
export const STELLAR_PUBLIC_KEY_REJECTION_MESSAGES: Record<
  StellarPublicKeyRejection,
  string
> = {
  MISSING: "publicKey must be provided when a public key is expected.",
  EMPTY: "publicKey must not be empty or blank.",
  NOT_A_STRING: "publicKey must be a string.",
  INVALID_LENGTH: `publicKey must be exactly ${STELLAR_PUBLIC_KEY_LENGTH} characters long.`,
  INVALID_PREFIX: "publicKey must start with the prefix G.",
  INVALID_CHARACTERS:
    "publicKey must only contain base32 characters (A-Z, 2-7).",
  STRKEY_DECODE_FAILED: "publicKey failed StrKey checksum validation.",
};

/**
 * Strictly parses a user-supplied Stellar public key using standard Stellar
 * SDK tooling (StrKey decoding). Designed to run at controller input time so
 * malformed keys are trapped before any downstream application or database
 * processing occurs.
 *
 * Rejection order:
 * 1. `null` / `undefined` - the explicitly expected field is absent.
 * 2. Empty or whitespace-only strings.
 * 3. Non-string values.
 * 4. Wrong length boundaries.
 * 5. Wrong prefix (must be `G`).
 * 6. Non-base32 characters (wrong prefix strings, symbols, whitespace inside).
 * 7. StrKey decode (checksum) validation for everything else.
 */
export function parseStellarPublicKey(
  input: unknown,
): ParseStellarPublicKeyResult {
  if (input === null || input === undefined) {
    return { ok: false, rejection: "MISSING" };
  }

  if (typeof input !== "string") {
    return { ok: false, rejection: "NOT_A_STRING" };
  }

  const trimmed = input.trim();

  if (trimmed === "") {
    return { ok: false, rejection: "EMPTY" };
  }

  if (trimmed.length !== STELLAR_PUBLIC_KEY_LENGTH) {
    return { ok: false, rejection: "INVALID_LENGTH" };
  }

  if (!trimmed.startsWith("G")) {
    return { ok: false, rejection: "INVALID_PREFIX" };
  }

  if (!BASE32_PATTERN.test(trimmed)) {
    return { ok: false, rejection: "INVALID_CHARACTERS" };
  }

  if (!StrKey.isValidEd25519PublicKey(trimmed)) {
    return { ok: false, rejection: "STRKEY_DECODE_FAILED" };
  }

  return { ok: true, publicKey: trimmed };
}

/** Type guard for a well-formed Stellar public key string. */
export function isValidStellarPublicKey(input: unknown): boolean {
  return parseStellarPublicKey(input).ok;
}
