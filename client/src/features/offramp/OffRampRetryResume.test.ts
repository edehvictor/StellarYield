/**
 * Off-Ramp Retry and Resume Tests (#963)
 *
 * Covers:
 * 1. Only safe (non-sensitive) resume metadata is persisted to localStorage.
 * 2. Retry works within the same session, but requires a restart after a
 *    genuine reload (new service instance, no in-memory raw request).
 * 3. findResumableTransaction / validateResumedTransaction correctly block
 *    resume on an expired quote, incomplete metadata, or a changed wallet.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OffRampService, isQuoteExpired, maskBankAccount, validateResumedTransaction, QUOTE_TTL_MS } from "./offRampService";
import type { WithdrawalRequest, OffRampTransaction } from "./types";

function makeRequest(overrides: Partial<WithdrawalRequest> = {}): WithdrawalRequest {
    return {
        vaultContractId: "test-vault",
        shares: 1000n,
        usdcAmount: 5000n,
        bankAccount: "123456789",
        bankName: "Chase",
        accountHolder: "John Doe",
        walletAddress: "GALICE",
        ...overrides,
    };
}

describe("OffRampService Retry and Resume", () => {
    let service: OffRampService;

    beforeEach(() => {
        service = new OffRampService("moonpay");
        localStorage.clear();
        global.fetch = vi.fn();
    });

    // ── Safe persistence ─────────────────────────────────────────────────

    describe("safe resume metadata persistence", () => {
        it("persists only masked bank account details, never the raw number", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-retry-1", status: "pending" }),
            });

            const tx = await service.initiateWithdrawal(makeRequest());

            expect(tx.bankAccount).toBe(maskBankAccount("123456789"));
            expect(tx.resumeMetadata).toBeDefined();
            expect(tx.resumeMetadata?.maskedBankAccount).toBe(maskBankAccount("123456789"));
            expect(tx.resumeMetadata?.bankName).toBe("Chase");
            expect(tx.resumeMetadata?.walletAddress).toBe("GALICE");

            // The raw account number must not appear anywhere in what's stored.
            const rawStorage = localStorage.getItem("stellar_yield_offramp_txns") ?? "";
            expect(rawStorage).not.toContain("123456789");

            const loaded = service.getAllTransactions()[0];
            expect(loaded.bankAccount).toBe(maskBankAccount("123456789"));
        });

        it("masks a short bank account entirely rather than under-masking it", () => {
            expect(maskBankAccount("12")).toBe("**");
            expect(maskBankAccount("1234")).toBe("****");
        });

        it("keeps the last 4 digits visible for longer account numbers", () => {
            expect(maskBankAccount("987654321")).toBe("*****4321");
        });
    });

    // ── isRetryable classification (pre-existing, exercised on first failure too) ──

    it("marks isRetryable on the very first failed submission (500)", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
        });

        await expect(service.initiateWithdrawal(makeRequest())).rejects.toThrow();

        const tx = service.getAllTransactions()[0];
        expect(tx.status).toBe("failed");
        expect(tx.isRetryable).toBe(true);
    });

    it("marks isRetryable false on the very first failed submission (403)", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: "Forbidden",
        });

        await expect(service.initiateWithdrawal(makeRequest())).rejects.toThrow();

        const tx = service.getAllTransactions()[0];
        expect(tx.status).toBe("failed");
        expect(tx.isRetryable).toBe(false);
    });

    // ── Same-session retry ───────────────────────────────────────────────

    it("successfully retries a failed transaction within the same session", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
        });

        await expect(service.initiateWithdrawal(makeRequest())).rejects.toThrow();
        const failedTx = service.getAllTransactions()[0];
        expect(failedTx.status).toBe("failed");

        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: failedTx.id, status: "pending" }),
        });

        const retriedTx = await service.retryTransaction(failedTx.id);
        expect(retriedTx.status).toBe("pending");
        expect(retriedTx.errorMessage).toBeUndefined();
    });

    // ── Reload behavior ──────────────────────────────────────────────────

    describe("after a reload (fresh service instance)", () => {
        it("can still poll status", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-resume", status: "pending" }),
            });
            const tx = await service.initiateWithdrawal(makeRequest());

            // Simulate a reload: a brand new service instance, same localStorage.
            const reloadedService = new OffRampService("moonpay");

            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ status: "completed" }),
            });
            const updated = await reloadedService.pollStatus(tx.id);
            expect(updated?.status).toBe("completed");
        });

        it("refuses to retry automatically — the raw request was never persisted", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: "Internal Server Error",
            });
            await expect(service.initiateWithdrawal(makeRequest())).rejects.toThrow();
            const failedTx = service.getAllTransactions()[0];

            // Simulate a reload: a brand new service instance, same localStorage,
            // but an empty in-memory rawRequests map.
            const reloadedService = new OffRampService("moonpay");

            await expect(reloadedService.retryTransaction(failedTx.id)).rejects.toMatchObject({
                message: expect.stringMatching(/start a new withdrawal/i),
            });
        });
    });

    // ── validateResumedTransaction / findResumableTransaction ───────────

    describe("validateResumedTransaction", () => {
        function baseTx(overrides: Partial<OffRampTransaction> = {}): OffRampTransaction {
            const now = Date.now();
            return {
                id: "tx-1",
                status: "pending",
                amount: "5000",
                currency: "USDC",
                bankAccount: "*****6789",
                memo: "SY:JohnDoe:123456",
                createdAt: now,
                quoteExpiresAt: now + QUOTE_TTL_MS,
                resumeMetadata: {
                    vaultContractId: "test-vault",
                    bankName: "Chase",
                    accountHolder: "John Doe",
                    maskedBankAccount: "*****6789",
                    walletAddress: "GALICE",
                },
                ...overrides,
            };
        }

        it("allows resume when the quote is fresh, metadata is complete, and the wallet matches", () => {
            const result = validateResumedTransaction(baseTx(), "GALICE");
            expect(result.canResume).toBe(true);
        });

        it("blocks resume when the quote has expired", () => {
            const expired = baseTx({ quoteExpiresAt: Date.now() - 1000 });
            const result = validateResumedTransaction(expired, "GALICE");
            expect(result.canResume).toBe(false);
            if (!result.canResume) expect(result.reason).toBe("quote_expired");
        });

        it("blocks resume at the exact expiry boundary instant", () => {
            const now = Date.now();
            const exactlyExpired = baseTx({ quoteExpiresAt: now });
            // isQuoteExpired uses strict `>`, so `now === quoteExpiresAt` is not yet expired.
            expect(isQuoteExpired(exactlyExpired, now)).toBe(false);
            expect(isQuoteExpired(exactlyExpired, now + 1)).toBe(true);
        });

        it("blocks resume when resumeMetadata is missing (pre-#963 persisted transaction)", () => {
            const legacy = baseTx({ resumeMetadata: undefined });
            const result = validateResumedTransaction(legacy, "GALICE");
            expect(result.canResume).toBe(false);
            if (!result.canResume) expect(result.reason).toBe("incomplete_metadata");
        });

        it("blocks resume when resumeMetadata is missing required fields", () => {
            const incomplete = baseTx({
                resumeMetadata: {
                    vaultContractId: "test-vault",
                    bankName: "",
                    accountHolder: "John Doe",
                    maskedBankAccount: "",
                },
            });
            const result = validateResumedTransaction(incomplete, "GALICE");
            expect(result.canResume).toBe(false);
            if (!result.canResume) expect(result.reason).toBe("incomplete_metadata");
        });

        it("blocks resume when the connected wallet differs from the originating wallet", () => {
            const result = validateResumedTransaction(baseTx(), "GBOB");
            expect(result.canResume).toBe(false);
            if (!result.canResume) expect(result.reason).toBe("wallet_changed");
        });

        it("allows resume when no wallet is currently connected (can't yet tell it changed)", () => {
            const result = validateResumedTransaction(baseTx(), null);
            expect(result.canResume).toBe(true);
        });

        it("allows resume when the transaction predates wallet tracking", () => {
            const noWallet = baseTx({
                resumeMetadata: {
                    vaultContractId: "test-vault",
                    bankName: "Chase",
                    accountHolder: "John Doe",
                    maskedBankAccount: "*****6789",
                    walletAddress: undefined,
                },
            });
            const result = validateResumedTransaction(noWallet, "GBOB");
            expect(result.canResume).toBe(true);
        });
    });

    describe("findResumableTransaction", () => {
        it("returns null when there is nothing pending", () => {
            expect(service.findResumableTransaction("GALICE")).toBeNull();
        });

        it("returns the most recent pending transaction with its validation result", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-a", status: "pending" }),
            });
            const tx = await service.initiateWithdrawal(makeRequest());

            const result = service.findResumableTransaction("GALICE");
            expect(result).not.toBeNull();
            expect(result?.transaction.id).toBe(tx.id);
            expect(result?.validation.canResume).toBe(true);
        });

        it("flags a wallet change on the resumable transaction", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-a", status: "pending" }),
            });
            await service.initiateWithdrawal(makeRequest({ walletAddress: "GALICE" }));

            const result = service.findResumableTransaction("GDIFFERENT");
            expect(result?.validation.canResume).toBe(false);
            if (result && !result.validation.canResume) {
                expect(result.validation.reason).toBe("wallet_changed");
            }
        });

        it("flags an expired quote on the resumable transaction", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-a", status: "pending" }),
            });
            const tx = await service.initiateWithdrawal(makeRequest());

            const result = service.findResumableTransaction("GALICE", tx.createdAt + QUOTE_TTL_MS + 1);
            expect(result?.validation.canResume).toBe(false);
            if (result && !result.validation.canResume) {
                expect(result.validation.reason).toBe("quote_expired");
            }
        });
    });
});
