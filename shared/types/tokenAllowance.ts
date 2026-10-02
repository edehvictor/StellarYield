/**
 * Typed error mapping for failed token allowance checks (#1395).
 *
 * Before a delegated transfer (`transfer_from`) can run, the client and the
 * server read the SEP-41 `allowance(owner, spender)` view to decide whether the
 * transfer has a chance of succeeding. That read fails for reasons callers must
 * branch on — the spender is short of allowance, the RPC is unreachable, the
 * token does not implement the allowance interface, or the amount being checked
 * is invalid.
 *
 * Rather than leaking the raw provider/RPC string into the UI, every failure is
 * reduced here to a stable `TokenAllowanceError` with deterministic copy and a
 * machine-readable code — the same approach `contractPanic.ts` takes for
 * contract failures. Nothing in this module parses human-readable error text.
 */

import type { DecodedContractPanic } from "./contractPanic";

/** Stable machine-readable codes for allowance-check failures. */
export type TokenAllowanceErrorCode =
  /** The spender's allowance is lower than the amount the transfer needs. */
  | "INSUFFICIENT_ALLOWANCE"
  /** The allowance view call reached the network but failed. */
  | "ALLOWANCE_READ_FAILED"
  /** The allowance view call exceeded the configured deadline. */
  | "ALLOWANCE_READ_TIMEOUT"
  /** The token does not expose a SEP-41 `allowance` entry point. */
  | "ALLOWANCE_UNSUPPORTED_TOKEN"
  /** The amount the caller asked to check is not a positive integer. */
  | "INVALID_ALLOWANCE_AMOUNT";

/** A resolved, user-facing allowance-check failure. */
export interface TokenAllowanceError {
  code: TokenAllowanceErrorCode;
  /** Short heading for a failure modal. */
  title: string;
  /** Friendly, deterministic explanation for the end user. */
  message: string;
  /** What the user (or operator) can do next. */
  remediation: string;
  /** Whether retrying the same check may succeed later. */
  retryable: boolean;
  /** Amount the transfer needed, when known. */
  required?: bigint;
  /** Allowance currently granted, when known. */
  available?: bigint;
  /** `required - available`, when both are known and the allowance is short. */
  shortfall?: bigint;
  /** Decoded contract failure when the read failed inside a contract call. */
  panic?: DecodedContractPanic;
}

/**
 * Structured reason an allowance check failed. Callers build this from typed
 * evidence (a shortfall comparison, a simulation outcome, a decoded panic) —
 * never from a raw provider string.
 */
export type AllowanceFailure =
  | { kind: "insufficient_allowance"; required: bigint; available: bigint }
  | { kind: "read_failed"; panic?: DecodedContractPanic }
  | { kind: "read_timeout" }
  | { kind: "unsupported_token"; tokenId?: string }
  | { kind: "invalid_amount"; reason: "non_positive" | "not_an_integer" };

/** The result of comparing an allowance against the amount a transfer needs. */
export interface AllowanceEvaluation {
  sufficient: boolean;
  /** `required - allowance` when the allowance is short, otherwise 0n. */
  shortfall: bigint;
}

/**
 * Compare a granted allowance against the amount a transfer needs.
 *
 * Pure and total: any non-positive `required` is treated as satisfied so that a
 * zero-amount transfer does not surface as an allowance failure.
 */
export function evaluateAllowance(allowance: bigint, required: bigint): AllowanceEvaluation {
  if (required <= 0n || allowance >= required) {
    return { sufficient: true, shortfall: 0n };
  }
  return { sufficient: false, shortfall: required - allowance };
}

type AllowanceCopy = Pick<
  TokenAllowanceError,
  "title" | "message" | "remediation" | "retryable"
>;

const ALLOWANCE_COPY: Record<TokenAllowanceErrorCode, AllowanceCopy> = {
  INSUFFICIENT_ALLOWANCE: {
    title: "Token Allowance Too Low",
    message:
      "This vault needs permission to move more of this token than you have currently approved.",
    remediation:
      "Increase the token allowance for the vault contract, then run the deposit again.",
    retryable: false,
  },
  ALLOWANCE_READ_FAILED: {
    title: "Could Not Check Token Allowance",
    message:
      "The token's allowance could not be read, so the transfer was not attempted.",
    remediation:
      "Refresh the page and try again. If this keeps happening, the token contract may be rejecting the allowance read.",
    retryable: true,
  },
  ALLOWANCE_READ_TIMEOUT: {
    title: "Allowance Check Timed Out",
    message:
      "The Stellar network did not respond while checking the token allowance.",
    remediation: "Wait a moment and retry the allowance check before depositing.",
    retryable: true,
  },
  ALLOWANCE_UNSUPPORTED_TOKEN: {
    title: "Token Does Not Support Allowances",
    message:
      "This token does not implement the SEP-41 allowance interface, so a delegated transfer cannot be pre-checked.",
    remediation:
      "Use a SEP-41 token that supports approve/allowance, or transfer the token directly instead of delegating.",
    retryable: false,
  },
  INVALID_ALLOWANCE_AMOUNT: {
    title: "Invalid Allowance Amount",
    message: "The amount being checked must be a positive, whole token value.",
    remediation: "Enter an amount greater than zero and try again.",
    retryable: false,
  },
} as const;

/**
 * Reduce a structured allowance failure to a stable, user-facing error.
 *
 * Deterministic for a given input: the same failure always maps to the same
 * code, title, message, and remediation.
 */
export function mapAllowanceFailure(failure: AllowanceFailure): TokenAllowanceError {
  switch (failure.kind) {
    case "insufficient_allowance": {
      const { shortfall } = evaluateAllowance(failure.available, failure.required);
      return {
        code: "INSUFFICIENT_ALLOWANCE",
        ...ALLOWANCE_COPY.INSUFFICIENT_ALLOWANCE,
        required: failure.required,
        available: failure.available,
        shortfall,
      };
    }
    case "read_failed":
      return {
        code: "ALLOWANCE_READ_FAILED",
        ...ALLOWANCE_COPY.ALLOWANCE_READ_FAILED,
        ...(failure.panic ? { panic: failure.panic } : {}),
      };
    case "read_timeout":
      return {
        code: "ALLOWANCE_READ_TIMEOUT",
        ...ALLOWANCE_COPY.ALLOWANCE_READ_TIMEOUT,
      };
    case "unsupported_token":
      return {
        code: "ALLOWANCE_UNSUPPORTED_TOKEN",
        ...ALLOWANCE_COPY.ALLOWANCE_UNSUPPORTED_TOKEN,
      };
    case "invalid_amount":
      return {
        code: "INVALID_ALLOWANCE_AMOUNT",
        ...ALLOWANCE_COPY.INVALID_ALLOWANCE_AMOUNT,
      };
  }
}

/** Allocates and returns every catalogued allowance error code. */
export function tokenAllowanceErrorCodes(): TokenAllowanceErrorCode[] {
  return Object.keys(ALLOWANCE_COPY) as TokenAllowanceErrorCode[];
}
