/**
 * Transaction Review Boundary Validation & Hardening (#1889)
 *
 * Provides pure, deterministic validation at the transaction review boundary
 * to protect against malformed, corrupted, or tampered external data.
 *
 * Guarantees:
 * 1. Untrusted fields are validated before reaching UI rendering or transaction signing.
 * 2. Failures return typed, machine-readable failure objects without mutating state.
 * 3. Existing balances and drafts remain untouched on validation or execution failures.
 * 4. Boundary is idempotent and allows safe retries once inputs are corrected.
 */

import {
  verifyQuoteAssumptionFingerprint,
  type QuoteAssumptions,
} from "./quoteAssumptionFingerprint";

export type TransactionReviewValidationErrorCode =
  | "MISSING_DATA"
  | "INVALID_WALLET_ADDRESS"
  | "INVALID_INPUT_AMOUNT"
  | "INVALID_INPUT_SYMBOL"
  | "INVALID_OUTPUT_AMOUNT"
  | "INVALID_OUTPUT_SYMBOL"
  | "INVALID_MIN_AMOUNT"
  | "MIN_AMOUNT_EXCEEDS_OUTPUT"
  | "INVALID_SLIPPAGE"
  | "INVALID_DECIMALS"
  | "INVALID_FINGERPRINT"
  | "ASSUMPTIONS_EXPIRED"
  | "ASSUMPTION_DRIFT"
  | "MALFORMED_ASSUMPTIONS";

export interface TransactionReviewValidationError {
  code: TransactionReviewValidationErrorCode;
  field: string;
  message: string;
  details?: unknown;
}

export interface SanitizedTokenDetail {
  symbol: string;
  amount: string;
  contractId?: string;
  decimals?: number;
}

export interface SanitizedVaultTokenDetail extends SanitizedTokenDetail {
  minAmount?: string;
}

export interface SanitizedTransactionReviewData {
  walletAddress: string;
  inputToken: SanitizedTokenDetail;
  vaultToken: SanitizedVaultTokenDetail;
  slippageTolerance: number;
  assumptions?: QuoteAssumptions | null;
  fingerprint?: string;
}

export type TransactionReviewValidationResult =
  | {
      valid: true;
      sanitized: SanitizedTransactionReviewData;
      error?: never;
    }
  | {
      valid: false;
      error: TransactionReviewValidationError;
      sanitized?: never;
    };

export interface RawTransactionReviewInput {
  walletAddress?: unknown;
  inputToken?: unknown;
  vaultToken?: unknown;
  slippageTolerance?: unknown;
  assumptions?: unknown;
  fingerprint?: unknown;
}

export interface ValidateTransactionReviewOptions {
  /** Reference timestamp in milliseconds for expiry checks (default: Date.now()). */
  nowMs?: number;
  /** Maximum allowable slippage tolerance percentage (default: 50%). */
  maxSlippagePct?: number;
}

/** Stellar Ed25519 public key (G...) or Contract ID (C...) format. */
const STELLAR_ADDRESS_REGEX = /^[GC][A-Za-z0-9_-]{9,64}$/;

/** Valid token symbol: 1-12 alphanumeric characters, dashes, or underscores. */
const TOKEN_SYMBOL_REGEX = /^[A-Za-z0-9_-]{1,12}$/;

/** Positive decimal or integer number string (no sign, no scientific notation). */
const POSITIVE_NUMBER_REGEX = /^\d+(\.\d+)?$/;

/** 64-character hexadecimal fingerprint (optional 0x or qaf- prefix). */
const FINGERPRINT_HEX_REGEX = /^(?:0x|qaf-)?([a-fA-F0-9]{64})$/;

/**
 * Validates untrusted transaction review fields at the boundary.
 *
 * Returns a typed success with sanitized fields, or a typed failure with
 * machine-readable error code and field name. Does not mutate external state.
 */
export function validateTransactionReview(
  input: unknown,
  options?: ValidateTransactionReviewOptions,
): TransactionReviewValidationResult {
  if (!input || typeof input !== "object") {
    return {
      valid: false,
      error: {
        code: "MISSING_DATA",
        field: "input",
        message: "Transaction review data is required and must be an object.",
      },
    };
  }

  const raw = input as RawTransactionReviewInput;
  const nowMs = options?.nowMs ?? Date.now();
  const maxSlippage = options?.maxSlippagePct ?? 50;

  // 1. Wallet Address
  if (typeof raw.walletAddress !== "string" || !STELLAR_ADDRESS_REGEX.test(raw.walletAddress.trim())) {
    return {
      valid: false,
      error: {
        code: "INVALID_WALLET_ADDRESS",
        field: "walletAddress",
        message: "Wallet address must be a valid 56-character Stellar public key (G...) or contract ID (C...).",
      },
    };
  }
  const cleanWalletAddress = raw.walletAddress.trim();

  // 2. Input Token
  if (!raw.inputToken || typeof raw.inputToken !== "object") {
    return {
      valid: false,
      error: {
        code: "INVALID_INPUT_AMOUNT",
        field: "inputToken",
        message: "Input token details are required.",
      },
    };
  }
  const rawInputToken = raw.inputToken as Record<string, unknown>;

  if (typeof rawInputToken.symbol !== "string" || !TOKEN_SYMBOL_REGEX.test(rawInputToken.symbol.trim())) {
    return {
      valid: false,
      error: {
        code: "INVALID_INPUT_SYMBOL",
        field: "inputToken.symbol",
        message: "Input token symbol must be 1-12 alphanumeric characters.",
      },
    };
  }
  const cleanInputSymbol = rawInputToken.symbol.trim();

  const rawInputAmountStr = String(rawInputToken.amount ?? "").trim();
  if (!POSITIVE_NUMBER_REGEX.test(rawInputAmountStr) || parseFloat(rawInputAmountStr) <= 0) {
    return {
      valid: false,
      error: {
        code: "INVALID_INPUT_AMOUNT",
        field: "inputToken.amount",
        message: "Input token amount must be a positive number.",
      },
    };
  }

  if (rawInputToken.decimals !== undefined && rawInputToken.decimals !== null) {
    const dec = Number(rawInputToken.decimals);
    if (!Number.isInteger(dec) || dec < 0 || dec > 18) {
      return {
        valid: false,
        error: {
          code: "INVALID_DECIMALS",
          field: "inputToken.decimals",
          message: "Input token decimals must be an integer between 0 and 18.",
        },
      };
    }
  }

  // 3. Vault / Output Token
  if (!raw.vaultToken || typeof raw.vaultToken !== "object") {
    return {
      valid: false,
      error: {
        code: "INVALID_OUTPUT_AMOUNT",
        field: "vaultToken",
        message: "Vault output token details are required.",
      },
    };
  }
  const rawVaultToken = raw.vaultToken as Record<string, unknown>;

  if (typeof rawVaultToken.symbol !== "string" || !TOKEN_SYMBOL_REGEX.test(rawVaultToken.symbol.trim())) {
    return {
      valid: false,
      error: {
        code: "INVALID_OUTPUT_SYMBOL",
        field: "vaultToken.symbol",
        message: "Vault token symbol must be 1-12 alphanumeric characters.",
      },
    };
  }
  const cleanVaultSymbol = rawVaultToken.symbol.trim();

  const rawVaultAmountStr = String(rawVaultToken.amount ?? "").trim();
  if (!POSITIVE_NUMBER_REGEX.test(rawVaultAmountStr) || parseFloat(rawVaultAmountStr) <= 0) {
    return {
      valid: false,
      error: {
        code: "INVALID_OUTPUT_AMOUNT",
        field: "vaultToken.amount",
        message: "Vault output amount must be a positive number.",
      },
    };
  }

  let cleanMinAmount: string | undefined;
  if (rawVaultToken.minAmount !== undefined && rawVaultToken.minAmount !== null && String(rawVaultToken.minAmount).trim() !== "") {
    const rawMinAmountStr = String(rawVaultToken.minAmount).trim();
    // A zero minimum is valid: it guarantees nothing beyond the simulated amount.
    if (!POSITIVE_NUMBER_REGEX.test(rawMinAmountStr)) {
      return {
        valid: false,
        error: {
          code: "INVALID_MIN_AMOUNT",
          field: "vaultToken.minAmount",
          message: "Minimum output amount must be a non-negative decimal.",
        },
      };
    }
    const numMin = parseFloat(rawMinAmountStr);
    const numExpected = parseFloat(rawVaultAmountStr);
    if (numMin > numExpected) {
      return {
        valid: false,
        error: {
          code: "MIN_AMOUNT_EXCEEDS_OUTPUT",
          field: "vaultToken.minAmount",
          message: "Minimum guaranteed output cannot exceed expected output amount.",
        },
      };
    }
    cleanMinAmount = rawMinAmountStr;
  }

  if (rawVaultToken.decimals !== undefined && rawVaultToken.decimals !== null) {
    const dec = Number(rawVaultToken.decimals);
    if (!Number.isInteger(dec) || dec < 0 || dec > 18) {
      return {
        valid: false,
        error: {
          code: "INVALID_DECIMALS",
          field: "vaultToken.decimals",
          message: "Vault token decimals must be an integer between 0 and 18.",
        },
      };
    }
  }

  // 4. Slippage Tolerance
  const numSlippage = Number(raw.slippageTolerance);
  if (
    raw.slippageTolerance === undefined ||
    raw.slippageTolerance === null ||
    !Number.isFinite(numSlippage) ||
    numSlippage < 0 ||
    numSlippage > maxSlippage
  ) {
    return {
      valid: false,
      error: {
        code: "INVALID_SLIPPAGE",
        field: "slippageTolerance",
        message: `Slippage tolerance must be a finite percentage between 0% and ${maxSlippage}%.`,
      },
    };
  }

  // 5. Fingerprint (optional)
  let cleanFingerprint: string | undefined;
  if (raw.fingerprint !== undefined && raw.fingerprint !== null && String(raw.fingerprint).trim() !== "") {
    const rawFpStr = String(raw.fingerprint).trim();
    const fpMatch = FINGERPRINT_HEX_REGEX.exec(rawFpStr);
    if (!fpMatch) {
      return {
        valid: false,
        error: {
          code: "INVALID_FINGERPRINT",
          field: "fingerprint",
          message: "Quote assumption fingerprint must be a 64-character hexadecimal digest.",
        },
      };
    }
    cleanFingerprint = fpMatch[1].toLowerCase();
  }

  // 6. Assumptions (optional)
  let cleanAssumptions: QuoteAssumptions | null = null;
  if (raw.assumptions !== undefined && raw.assumptions !== null) {
    if (typeof raw.assumptions !== "object") {
      return {
        valid: false,
        error: {
          code: "MALFORMED_ASSUMPTIONS",
          field: "assumptions",
          message: "Quote assumptions must be an object.",
        },
      };
    }
    const a = raw.assumptions as Record<string, unknown>;
    if (
      typeof a.inputTokenContract !== "string" ||
      typeof a.vaultTokenContract !== "string" ||
      typeof a.amountInStroops !== "string" ||
      typeof a.expectedAmountOutStroops !== "string" ||
      typeof a.minAmountOutStroops !== "string" ||
      typeof a.quotedAt !== "string" ||
      typeof a.expiresAt !== "string"
    ) {
      return {
        valid: false,
        error: {
          code: "MALFORMED_ASSUMPTIONS",
          field: "assumptions",
          message: "Quote assumptions is missing required fields or has invalid types.",
        },
      };
    }

    const expiresMs = new Date(a.expiresAt).getTime();
    if (!Number.isFinite(expiresMs)) {
      return {
        valid: false,
        error: {
          code: "MALFORMED_ASSUMPTIONS",
          field: "assumptions.expiresAt",
          message: "Quote assumptions contains an unparseable expiresAt timestamp.",
        },
      };
    }

    if (nowMs > expiresMs) {
      return {
        valid: false,
        error: {
          code: "ASSUMPTIONS_EXPIRED",
          field: "assumptions.expiresAt",
          message: "Quote assumptions have expired. Please refresh the quote before signing.",
        },
      };
    }

    cleanAssumptions = raw.assumptions as QuoteAssumptions;

    // If fingerprint is provided alongside assumptions, verify cryptographic match
    if (cleanFingerprint) {
      const fpVerdict = verifyQuoteAssumptionFingerprint(cleanAssumptions, cleanFingerprint, { nowMs });
      if (!fpVerdict.valid) {
        return {
          valid: false,
          error: {
            code: "ASSUMPTION_DRIFT",
            field: "fingerprint",
            message: fpVerdict.message,
            details: fpVerdict.driftReasons,
          },
        };
      }
    }
  }

  return {
    valid: true,
    sanitized: {
      walletAddress: cleanWalletAddress,
      inputToken: {
        symbol: cleanInputSymbol,
        amount: rawInputAmountStr,
        contractId: typeof rawInputToken.contractId === "string" ? rawInputToken.contractId.trim() : undefined,
        decimals: rawInputToken.decimals !== undefined ? Number(rawInputToken.decimals) : undefined,
      },
      vaultToken: {
        symbol: cleanVaultSymbol,
        amount: rawVaultAmountStr,
        minAmount: cleanMinAmount,
        contractId: typeof rawVaultToken.contractId === "string" ? rawVaultToken.contractId.trim() : undefined,
        decimals: rawVaultToken.decimals !== undefined ? Number(rawVaultToken.decimals) : undefined,
      },
      slippageTolerance: numSlippage,
      assumptions: cleanAssumptions,
      fingerprint: cleanFingerprint,
    },
  };
}
