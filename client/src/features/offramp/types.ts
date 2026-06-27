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
    bankAccount: string;
    memo: string;
    createdAt: number;
    completedAt?: number;
    /** Unix ms timestamp after which the provider quote is no longer valid. */
    quoteExpiresAt?: number;
    errorMessage?: string;
    isRetryable?: boolean;
    request?: WithdrawalRequest;
}

export interface WithdrawalRequest {
    vaultContractId: string;
    shares: bigint;
    usdcAmount: bigint;
    bankAccount: string;
    bankName: string;
    accountHolder: string;
}

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
