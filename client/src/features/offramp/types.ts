/**
 * Fiat Off-Ramp Integration Types
 */

export type OffRampProvider = "moonpay" | "anchor";

export type OffRampErrorType =
  | "INVALID_BANK_ACCOUNT"
  | "INVALID_MEMO"
  | "NETWORK_ERROR"
  | "SUBMISSION_FAILED"
  | "HTTP_401"
  | "HTTP_403"
  | "HTTP_500"
  | "HTTP_503";

export interface OffRampConfig {
    provider: OffRampProvider;
    apiKey: string;
    apiSecret?: string;
    baseUrl: string;
}

export type OffRampStatus = "idle" | "pending" | "completed" | "failed";

export interface OffRampTransaction {
    id: string;
    status: OffRampStatus;
    amount: string;
    currency: string;
    /** Masked once persisted — see maskBankAccount. Never the full account number (#963). */
    bankAccount: string;
    memo: string;
    createdAt: number;
    completedAt?: number;
    /** Unix ms timestamp after which the provider quote is no longer valid. */
    quoteExpiresAt?: number;
    errorMessage?: string;
    isRetryable?: boolean;
    /** Non-sensitive fields safe to persist and use to validate a resume attempt (#963). */
    resumeMetadata?: SafeResumeMetadata;
}

export interface WithdrawalRequest {
    vaultContractId: string;
    shares: bigint;
    usdcAmount: bigint;
    bankAccount: string;
    bankName: string;
    accountHolder: string;
    /** Wallet initiating this withdrawal — used to detect a changed-wallet resume (#963). */
    walletAddress?: string;
}

/**
 * Non-sensitive fields safe to persist to localStorage for resuming a
 * withdrawal across a page reload. Deliberately excludes the raw bank
 * account number and any provider credentials — only a masked account
 * number is retained (#963).
 */
export interface SafeResumeMetadata {
    vaultContractId: string;
    bankName: string;
    accountHolder: string;
    maskedBankAccount: string;
    walletAddress?: string;
}

export type ResumeBlockedReason = "quote_expired" | "incomplete_metadata" | "wallet_changed";

export type ResumeValidationResult =
    | { canResume: true }
    | { canResume: false; reason: ResumeBlockedReason; message: string };

/**
 * OffRampError class for handling off-ramp specific errors
 */
export class OffRampError extends Error {
    type?: OffRampErrorType;
    userMessage?: string;
    retryable?: boolean;
    transactionId?: string;
    cause?: Error;

    constructor(message: string, type?: OffRampErrorType, cause?: Error) {
        super(message);
        this.name = "OffRampError";
        this.type = type;
        this.cause = cause;
        Object.setPrototypeOf(this, OffRampError.prototype);
    }
}
