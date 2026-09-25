/**
 * Fiat Off-Ramp Service
 * Handles integration with MoonPay or Stellar Anchor for bank withdrawals
 */

import type {
    OffRampTransaction,
    WithdrawalRequest,
    OffRampProvider,
    OffRampErrorType,
    SafeResumeMetadata,
    ResumeValidationResult,
} from "./types";
import { OffRampError } from "./types";

function createOffRampError(
    type: OffRampErrorType,
    userMessage: string,
    retryable: boolean,
    cause?: Error,
    transactionId?: string,
): OffRampError {
    const err = new OffRampError(userMessage, type, cause);
    err.userMessage = userMessage;
    err.retryable = retryable;
    err.transactionId = transactionId;
    return err;
}

function httpErrorType(status: number): OffRampErrorType {
    const known = [401, 403, 500, 503] as const;
    if ((known as readonly number[]).includes(status)) {
        return `HTTP_${status}` as OffRampErrorType;
    }
    return "NETWORK_ERROR";
}

/** Default quote validity window: 5 minutes. */
export const QUOTE_TTL_MS = 5 * 60 * 1_000;

/**
 * Returns true when the transaction's provider quote has expired.
 * A transaction without a quoteExpiresAt is treated as non-expiring.
 */
export function isQuoteExpired(tx: OffRampTransaction, nowMs = Date.now()): boolean {
    if (tx.quoteExpiresAt === undefined) return false;
    return nowMs > tx.quoteExpiresAt;
}

/** Mask a bank account number for safe display/storage, keeping only the last 4 characters. */
export function maskBankAccount(bankAccount: string): string {
    if (bankAccount.length <= 4) return "*".repeat(bankAccount.length);
    return "*".repeat(bankAccount.length - 4) + bankAccount.slice(-4);
}

function toSafeResumeMetadata(request: WithdrawalRequest): SafeResumeMetadata {
    return {
        vaultContractId: request.vaultContractId,
        bankName: request.bankName,
        accountHolder: request.accountHolder,
        maskedBankAccount: maskBankAccount(request.bankAccount),
        walletAddress: request.walletAddress,
    };
}

/**
 * Decide whether a persisted transaction is safe to silently resume after a
 * reload, or whether the caller should show a restart flow instead (#963).
 *
 * Checks, in order: quote expiry, presence of complete resume metadata
 * (a transaction persisted before this field existed, or corrupted in
 * storage, is treated as incomplete), and whether the wallet resuming the
 * flow matches the wallet that started it.
 */
export function validateResumedTransaction(
    tx: OffRampTransaction,
    currentWalletAddress: string | null,
    nowMs = Date.now(),
): ResumeValidationResult {
    if (isQuoteExpired(tx, nowMs)) {
        return {
            canResume: false,
            reason: "quote_expired",
            message: "This withdrawal's quote has expired. Start a new withdrawal to get current rates.",
        };
    }

    if (!tx.resumeMetadata || !tx.resumeMetadata.maskedBankAccount || !tx.resumeMetadata.bankName) {
        return {
            canResume: false,
            reason: "incomplete_metadata",
            message: "This withdrawal is missing required details and can't be resumed automatically.",
        };
    }

    if (
        tx.resumeMetadata.walletAddress !== undefined &&
        currentWalletAddress !== null &&
        tx.resumeMetadata.walletAddress !== currentWalletAddress
    ) {
        return {
            canResume: false,
            reason: "wallet_changed",
            message: "This withdrawal was started from a different wallet. Reconnect that wallet or start a new withdrawal.",
        };
    }

    return { canResume: true };
}

const STORAGE_KEY = "stellar_yield_offramp_txns";

const OFFRAMP_PROXY = "/api/offramp";

export class OffRampService {
    readonly provider: OffRampProvider;

    /**
     * Raw request payloads (including the unmasked bank account), kept
     * in-memory only for same-session retries. Never persisted — a fresh
     * page load starts with an empty map, which is what forces
     * retryTransaction to require a restart instead of silently
     * resubmitting after a reload (#963).
     */
    private readonly rawRequests = new Map<string, WithdrawalRequest>();

    constructor(provider: OffRampProvider) {
        this.provider = provider;
    }

    /**
     * Initiate a fiat off-ramp transaction
     * Constructs withdrawal: vault shares → USDC → fiat wire
     */
    async initiateWithdrawal(request: WithdrawalRequest): Promise<OffRampTransaction> {
        const txId = `offramp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        // Kept in-memory only — see rawRequests doc comment.
        this.rawRequests.set(txId, request);

        const now = Date.now();
        const transaction: OffRampTransaction = {
            id: txId,
            status: "pending",
            amount: request.usdcAmount.toString(),
            currency: "USDC",
            bankAccount: maskBankAccount(request.bankAccount),
            memo: this.generateMemo(request),
            createdAt: now,
            quoteExpiresAt: now + QUOTE_TTL_MS,
            resumeMetadata: toSafeResumeMetadata(request),
        };

        // Validate destination address and memo
        this.validateDestination(request.bankAccount, transaction.memo);

        // Store transaction locally (safe fields only — see resumeMetadata)
        this.saveTransaction(transaction);

        // Call off-ramp provider API
        try {
            await this.submitToProvider(transaction, request);
        } catch (error) {
            transaction.status = "failed";
            transaction.isRetryable = this.checkIfRetryable(error);
            if (error instanceof OffRampError) {
                transaction.errorMessage = error.userMessage;
            } else {
                transaction.errorMessage = error instanceof Error ? error.message : "Unknown error";
            }
            this.saveTransaction(transaction);
            throw error;
        }

        return transaction;
    }

    /**
     * Retry a failed transaction. Only possible within the same session
     * that created it — the raw request (needed to resubmit the actual
     * bank account to the provider) is never persisted, so after a reload
     * this throws and the caller should fall back to a restart flow (#963).
     */
    async retryTransaction(txId: string): Promise<OffRampTransaction> {
        const tx = this.loadTransaction(txId);
        if (!tx) throw new Error("Transaction not found");

        const rawRequest = this.rawRequests.get(txId);
        if (!rawRequest) {
            throw createOffRampError(
                "SUBMISSION_FAILED",
                "This withdrawal can no longer be retried automatically after a reload. Please start a new withdrawal.",
                false,
                undefined,
                txId,
            );
        }

        tx.status = "pending";
        tx.errorMessage = undefined;
        tx.isRetryable = undefined;
        this.saveTransaction(tx);

        try {
            await this.submitToProvider(tx, rawRequest);
            return tx;
        } catch (error) {
            tx.status = "failed";
            tx.errorMessage = error instanceof Error ? error.message : "Retry failed";
            tx.isRetryable = this.checkIfRetryable(error);
            this.saveTransaction(tx);
            throw error;
        }
    }

    /**
     * Find the most recently created pending transaction, if any, and
     * validate whether it's safe to silently resume (#963). Callers (e.g.
     * the panel's mount effect) should use this instead of blindly resuming
     * the newest pending transaction — see validateResumedTransaction.
     */
    findResumableTransaction(
        currentWalletAddress: string | null,
        nowMs = Date.now(),
    ): { transaction: OffRampTransaction; validation: ResumeValidationResult } | null {
        const pending = this.getAllTransactions()
            .filter((t) => t.status === "pending")
            .sort((a, b) => b.createdAt - a.createdAt)[0];

        if (!pending) return null;

        return {
            transaction: pending,
            validation: validateResumedTransaction(pending, currentWalletAddress, nowMs),
        };
    }

    /**
     * Poll off-ramp provider for transaction status
     */
    async pollStatus(txId: string): Promise<OffRampTransaction | null> {
        const tx = this.loadTransaction(txId);
        if (!tx) return null;

        // Don't poll if already in a terminal success state
        if (tx.status === "completed") return tx;

        try {
            const response = await fetch(`${OFFRAMP_PROXY}/transactions/${encodeURIComponent(txId)}`);

            if (!response.ok) {
                throw createOffRampError(
                    httpErrorType(response.status),
                    `Status code: ${response.status}`,
                    response.status >= 500,
                );
            }

            const data = (await response.json()) as { status: string; error?: string };
            const status = this.mapProviderStatus(data.status);

            tx.status = status;
            if (status === "completed") {
                tx.completedAt = Date.now();
                tx.isRetryable = false;
            } else if (status === "failed") {
                tx.errorMessage = data.error || "Transaction failed";
                tx.isRetryable = false;
            }

            this.saveTransaction(tx);
            return tx;
        } catch (error) {
            const isRetryable = this.checkIfRetryable(error);
            tx.isRetryable = isRetryable;
            if (!isRetryable) {
                tx.status = "failed";
                tx.errorMessage = error instanceof Error ? error.message : "Poll failed";
            }
            if (error instanceof OffRampError) {
                throw error;
            }
            tx.status = "failed";
            tx.errorMessage = error instanceof Error ? error.message : "Poll failed";
            this.saveTransaction(tx);
            throw createOffRampError(
                "NETWORK_ERROR",
                "Unable to check transaction status. Please try again later.",
                true,
                error instanceof Error ? error : undefined,
                txId,
            );
        }
    }

    private checkIfRetryable(error: unknown): boolean {
        if (!(error instanceof Error)) return true;
        const msg = error.message.toLowerCase();
        
        // Terminal errors
        if (msg.includes("invalid") || msg.includes("forbidden") || msg.includes("unauthorized")) {
            return false;
        }
        
        // Transient errors
        if (msg.includes("timeout") || msg.includes("network") || msg.includes("500") || msg.includes("429")) {
            return true;
        }
        
        return true; // Default to retryable for safety
    }

    /**
     * Get all transactions for current user
     */
    getAllTransactions(): OffRampTransaction[] {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? (JSON.parse(stored, this.bigIntReviver) as OffRampTransaction[]) : [];
        } catch {
            return [];
        }
    }

    /**
     * Generate memo for off-ramp deposit address
     * Format: "SY:{accountHolder}:{timestamp}" (max 28 chars for Stellar)
     */
    private generateMemo(request: WithdrawalRequest): string {
        const sanitized = request.accountHolder.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
        const ts = Date.now().toString().slice(-6);
        return `SY:${sanitized}:${ts}`.slice(0, 28);
    }

    /**
     * Validate destination address and memo to prevent fund loss
     */
    private validateDestination(bankAccount: string, memo: string): void {
        if (!bankAccount || bankAccount.length < 8) {
            throw createOffRampError("INVALID_BANK_ACCOUNT", "Invalid bank account", false);
        }
        if (!memo || memo.length === 0 || memo.length > 28) {
            throw createOffRampError("INVALID_MEMO", "Invalid memo format", false);
        }
    }

    /**
     * Submit withdrawal to off-ramp provider
     */
    private async submitToProvider(
        transaction: OffRampTransaction,
        request: WithdrawalRequest,
    ): Promise<void> {
        const payload = {
            amount: transaction.amount,
            currency: transaction.currency,
            // The raw (unmasked) bank account from the in-memory request —
            // transaction.bankAccount is masked for safe storage/display (#963).
            bankAccount: request.bankAccount,
            memo: transaction.memo,
            accountHolder: request.accountHolder,
            bankName: request.bankName,
        };

        try {
            // Route through backend proxy — API key stays server-side
            const response = await fetch(`${OFFRAMP_PROXY}/withdrawals`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw createOffRampError(
                    httpErrorType(response.status),
                    `Provider error: ${response.statusText}`,
                    response.status >= 500,
                );
            }
        } catch (error) {
            if (error instanceof OffRampError) {
                throw error;
            }
            throw createOffRampError(
                "SUBMISSION_FAILED",
                error instanceof Error ? error.message : "Unknown error",
                true,
                error instanceof Error ? error : undefined,
            );
        }
    }

    /**
     * Map provider status to internal status
     */
    private mapProviderStatus(providerStatus: string): "pending" | "completed" | "failed" {
        const statusMap: Record<string, "pending" | "completed" | "failed"> = {
            pending: "pending",
            processing: "pending",
            completed: "completed",
            success: "completed",
            failed: "failed",
            error: "failed",
        };
        return statusMap[providerStatus.toLowerCase()] || "pending";
    }

    private saveTransaction(tx: OffRampTransaction): void {
        const all = this.getAllTransactions();
        const idx = all.findIndex((t) => t.id === tx.id);
        if (idx >= 0) {
            all[idx] = tx;
        } else {
            all.push(tx);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all, this.bigIntReplacer));
    }

    private bigIntReplacer(_key: string, value: any): any {
        return typeof value === "bigint" ? value.toString() + "n" : value;
    }

    private bigIntReviver(_key: string, value: any): any {
        if (typeof value === "string" && /^\d+n$/.test(value)) {
            return BigInt(value.slice(0, -1));
        }
        return value;
    }

    private loadTransaction(txId: string): OffRampTransaction | null {
        const all = this.getAllTransactions();
        return all.find((t) => t.id === txId) || null;
    }
}
