/**
 * Fiat Off-Ramp Service
 * Handles integration with MoonPay or Stellar Anchor for bank withdrawals
 */

import type { OffRampTransaction, WithdrawalRequest, OffRampProvider } from "./types";

const STORAGE_KEY = "stellar_yield_offramp_txns";

export class OffRampService {
    private provider: OffRampProvider;
    private apiKey: string;
    private baseUrl: string;

    constructor(provider: OffRampProvider, apiKey: string, baseUrl: string) {
        this.provider = provider;
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }

    /**
     * Initiate a fiat off-ramp transaction
     * Constructs withdrawal: vault shares → USDC → fiat wire
     */
    async initiateWithdrawal(request: WithdrawalRequest): Promise<OffRampTransaction> {
        const txId = `offramp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

        const transaction: OffRampTransaction = {
            id: txId,
            status: "pending",
            amount: request.usdcAmount.toString(),
            currency: "USDC",
            bankAccount: request.bankAccount,
            memo: this.generateMemo(request),
            createdAt: Date.now(),
        };

        // Validate destination address and memo
        this.validateDestination(request.bankAccount, transaction.memo);

        // Store transaction locally
        this.saveTransaction(transaction);

        // Call off-ramp provider API
        await this.submitToProvider(transaction, request);

        return transaction;
    }

    /**
     * Poll off-ramp provider for transaction status
     */
    async pollStatus(txId: string): Promise<OffRampTransaction | null> {
        const tx = this.loadTransaction(txId);
        if (!tx) return null;

        try {
            const response = await fetch(`${this.baseUrl}/transactions/${txId}`, {
                headers: { Authorization: `Bearer ${this.apiKey}` },
            });

            if (!response.ok) throw new Error(`Status code: ${response.status}`);

            const data = (await response.json()) as { status: string; error?: string };
            const status = this.mapProviderStatus(data.status);

            tx.status = status;
            if (status === "completed") {
                tx.completedAt = Date.now();
            } else if (status === "failed") {
                tx.errorMessage = data.error || "Unknown error";
            }

            this.saveTransaction(tx);
            return tx;
        } catch (error) {
            tx.status = "failed";
            tx.errorMessage = error instanceof Error ? error.message : "Poll failed";
            this.saveTransaction(tx);
            return tx;
        }
    }

    /**
     * Get all transactions for current user
     */
    getAllTransactions(): OffRampTransaction[] {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? (JSON.parse(stored) as OffRampTransaction[]) : [];
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
            throw new Error("Invalid bank account number");
        }
        if (!memo || memo.length === 0 || memo.length > 28) {
            throw new Error("Invalid memo format");
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
            bankAccount: transaction.bankAccount,
            memo: transaction.memo,
            accountHolder: request.accountHolder,
            bankName: request.bankName,
        };

        const response = await fetch(`${this.baseUrl}/withdrawals`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`Provider error: ${response.statusText}`);
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
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    }

    private loadTransaction(txId: string): OffRampTransaction | null {
        const all = this.getAllTransactions();
        return all.find((t) => t.id === txId) || null;
    }
}
