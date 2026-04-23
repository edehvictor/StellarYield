/**
 * Fiat Off-Ramp Integration Types
 */

export type OffRampProvider = "moonpay" | "anchor";

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
    errorMessage?: string;
}

export interface WithdrawalRequest {
    vaultContractId: string;
    shares: bigint;
    usdcAmount: bigint;
    bankAccount: string;
    bankName: string;
    accountHolder: string;
}
