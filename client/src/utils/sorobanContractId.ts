/**
 * Frontend validation for Soroban contract IDs (issue #1397).
 *
 * A valid Soroban contract address (strkey type C) is:
 *   - Exactly 56 characters long
 *   - Starts with the letter C
 *   - Contains only base-32 alphabet characters: A-Z and 2-7
 *
 * Reference: https://stellar.org/protocol/sep-23 (strkey encoding)
 */

const SOROBAN_CONTRACT_ALPHABET = /^[A-Z2-7]+$/;
const SOROBAN_CONTRACT_LENGTH = 56;
const SOROBAN_CONTRACT_PREFIX = "C";

export type ContractIdValidationResult =
  | { valid: true }
  | { valid: false; reason: ContractIdValidationError };

export type ContractIdValidationError =
  | "EMPTY"
  | "WRONG_LENGTH"
  | "WRONG_PREFIX"
  | "INVALID_CHARACTERS";

/** Stable, user-facing messages keyed by error code. */
export const CONTRACT_ID_ERROR_MESSAGES: Record<ContractIdValidationError, string> = {
  EMPTY: "Contract ID is required.",
  WRONG_LENGTH: `Contract ID must be exactly ${SOROBAN_CONTRACT_LENGTH} characters.`,
  WRONG_PREFIX: 'Soroban contract IDs start with "C".',
  INVALID_CHARACTERS:
    "Contract ID may only contain uppercase letters A–Z and digits 2–7.",
};

/**
 * Validates a raw string as a Soroban contract address.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, reason }` with a
 * stable error code that callers can map to a localized message.
 */
export function validateSorobanContractId(
  raw: unknown,
): ContractIdValidationResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { valid: false, reason: "EMPTY" };
  }

  const trimmed = raw.trim();

  if (trimmed.length !== SOROBAN_CONTRACT_LENGTH) {
    return { valid: false, reason: "WRONG_LENGTH" };
  }

  if (!trimmed.startsWith(SOROBAN_CONTRACT_PREFIX)) {
    return { valid: false, reason: "WRONG_PREFIX" };
  }

  if (!SOROBAN_CONTRACT_ALPHABET.test(trimmed)) {
    return { valid: false, reason: "INVALID_CHARACTERS" };
  }

  return { valid: true };
}

/**
 * Convenience wrapper: returns `true` when the string is a valid contract ID.
 */
export function isValidSorobanContractId(raw: unknown): boolean {
  return validateSorobanContractId(raw).valid;
}

/**
 * Returns a human-readable error message for `raw`, or `null` when valid.
 * Suitable for direct use in form field `helperText` props.
 */
export function getSorobanContractIdError(raw: unknown): string | null {
  const result = validateSorobanContractId(raw);
  if (result.valid) return null;
  return CONTRACT_ID_ERROR_MESSAGES[result.reason];
}
