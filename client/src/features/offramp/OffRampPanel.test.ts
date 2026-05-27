/**
 * Off-Ramp Panel Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OffRampService } from "./offRampService";
import type { WithdrawalRequest } from "./types";

describe("OffRampService", () => {
    let service: OffRampService;

    beforeEach(() => {
        service = new OffRampService("moonpay", "test-key", "https://api.test.com");
        localStorage.clear();

        // Mock fetch
        global.fetch = vi.fn();
    });

    it("should generate valid memo", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: "tx-123", memo: "SY:test" }),
        });

        const request: WithdrawalRequest = {
            vaultContractId: "test-vault",
            shares: 1000n,
            usdcAmount: 5000n,
            bankAccount: "123456789",
            bankName: "Chase",
            accountHolder: "John Doe",
        };

        const tx = await service.initiateWithdrawal(request);
        expect(tx.memo).toBeDefined();
        expect(tx.memo.length).toBeLessThanOrEqual(28);
        expect(tx.memo).toMatch(/^SY:/);
    });

    it("should validate bank account", async () => {
        const request: WithdrawalRequest = {
            vaultContractId: "test-vault",
            shares: 1000n,
            usdcAmount: 5000n,
            bankAccount: "123", // Too short
            bankName: "Chase",
            accountHolder: "John Doe",
        };

        await expect(service.initiateWithdrawal(request)).rejects.toThrow("Invalid bank account");
    });

    it("should persist transactions", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: "tx-456", memo: "SY:test2" }),
        });

        const request: WithdrawalRequest = {
            vaultContractId: "test-vault",
            shares: 1000n,
            usdcAmount: 5000n,
            bankAccount: "123456789",
            bankName: "Chase",
            accountHolder: "John Doe",
        };

        const tx = await service.initiateWithdrawal(request);
        const all = service.getAllTransactions();

        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(tx.id);
    });

    it("should map provider status correctly", async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: "tx-789", memo: "SY:test3" }),
        });

        const request: WithdrawalRequest = {
            vaultContractId: "test-vault",
            shares: 1000n,
            usdcAmount: 5000n,
            bankAccount: "123456789",
            bankName: "Chase",
            accountHolder: "John Doe",
        };

        const tx = await service.initiateWithdrawal(request);

        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ status: "pending" }),
        });

        const polled = await service.pollStatus(tx.id);

        expect(polled).toBeDefined();
        expect(["pending", "completed", "failed"]).toContain(polled?.status);
    });
});


describe("OffRampService - Failure Modes", () => {
    let service: OffRampService;

    beforeEach(() => {
        service = new OffRampService("moonpay", "test-key", "https://api.test.com");
        localStorage.clear();
        global.fetch = vi.fn();
    });

    describe("Unsupported Region", () => {
        it("should handle unsupported region error", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({ message: "region not supported" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            await expect(service.initiateWithdrawal(request)).rejects.toThrow();
        });
    });

    describe("Invalid Bank Account", () => {
        it("should reject bank account with less than 8 characters", async () => {
            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "1234567", // 7 chars
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            await expect(service.initiateWithdrawal(request)).rejects.toThrow("Invalid bank account");
        });

        it("should accept valid bank account", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-123" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "12345678", // 8 chars
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            const tx = await service.initiateWithdrawal(request);
            expect(tx.status).toBe("pending");
        });
    });

    describe("Invalid Memo", () => {
        it("should handle special characters in account holder name", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-123" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John@Doe#123", // Special chars
            };

            const tx = await service.initiateWithdrawal(request);
            expect(tx.memo).toMatch(/^SY:[a-zA-Z0-9]+:\d+$/);
            expect(tx.memo.length).toBeLessThanOrEqual(28);
        });
    });

    describe("Provider Downtime", () => {
        it("should handle 503 Service Unavailable", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 503,
                json: async () => ({ message: "Service Unavailable" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            await expect(service.initiateWithdrawal(request)).rejects.toThrow();
        });

        it("should handle network timeout", async () => {
            (global.fetch as any).mockRejectedValueOnce(new Error("Network timeout"));

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            await expect(service.initiateWithdrawal(request)).rejects.toThrow();
        });
    });

    describe("Insufficient Liquidity", () => {
        it("should handle insufficient liquidity error", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({ message: "insufficient liquidity" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            await expect(service.initiateWithdrawal(request)).rejects.toThrow();
        });
    });

    describe("Transaction Already Exists", () => {
        it("should handle duplicate transaction error", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({ message: "transaction already exists" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            await expect(service.initiateWithdrawal(request)).rejects.toThrow();
        });
    });

    describe("Authentication Failure", () => {
        it("should handle 401 Unauthorized", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 401,
                json: async () => ({ message: "Unauthorized" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            await expect(service.initiateWithdrawal(request)).rejects.toThrow();
        });

        it("should handle 403 Forbidden", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 403,
                json: async () => ({ message: "Forbidden" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            await expect(service.initiateWithdrawal(request)).rejects.toThrow();
        });
    });

    describe("Status Polling", () => {
        it("should handle poll status errors", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "tx-123" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            const tx = await service.initiateWithdrawal(request);

            // Mock poll failure
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 503,
                json: async () => ({ message: "Service Unavailable" }),
            });

            await expect(service.pollStatus(tx.id)).rejects.toThrow();
        });

        it("should return null for non-existent transaction", async () => {
            const result = await service.pollStatus("non-existent-id");
            expect(result).toBeNull();
        });
    });

    describe("Error Message Formatting", () => {
        it("should provide user-friendly error messages", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({ message: "region not supported" }),
            });

            const request: WithdrawalRequest = {
                vaultContractId: "test-vault",
                shares: 1000n,
                usdcAmount: 5000n,
                bankAccount: "123456789",
                bankName: "Chase",
                accountHolder: "John Doe",
            };

            try {
                await service.initiateWithdrawal(request);
            } catch (error: unknown) {
                const err = error as any;
                expect(err.userMessage).toBeDefined();
                expect(err.type).toBeDefined();
                expect(err.retryable).toBeDefined();
            }
        });
    });
});
