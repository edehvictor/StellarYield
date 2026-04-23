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
        const polled = await service.pollStatus(tx.id);

        expect(polled).toBeDefined();
        expect(["pending", "completed", "failed"]).toContain(polled?.status);
    });
});
