/**
 * Portfolio Builder Utilities Tests
 */

import { describe, it, expect } from "vitest";
import {
    calculateBlendedApy,
    isValidAllocation,
    distributeAmount,
    normalizeWeights,
} from "./portfolioUtils";
import type { VaultAllocation } from "./types";

describe("Portfolio Utils", () => {
    const mockAllocations: VaultAllocation[] = [
        {
            vaultContractId: "vault1",
            vaultName: "Vault A",
            apy: 10,
            weight: 50,
            amount: 0n,
        },
        {
            vaultContractId: "vault2",
            vaultName: "Vault B",
            apy: 8,
            weight: 50,
            amount: 0n,
        },
    ];

    it("should calculate blended APY correctly", () => {
        const apy = calculateBlendedApy(mockAllocations);
        expect(apy).toBe(9); // (10 * 0.5) + (8 * 0.5)
    });

    it("should validate valid allocations", () => {
        expect(isValidAllocation(mockAllocations)).toBe(true);
    });

    it("should reject invalid allocations", () => {
        const invalid = [
            { ...mockAllocations[0], weight: 60 },
            { ...mockAllocations[1], weight: 30 },
        ];
        expect(isValidAllocation(invalid)).toBe(false);
    });

    it("should distribute amount correctly", () => {
        const total = 10000n;
        const distributed = distributeAmount(total, mockAllocations);

        const sum = distributed.reduce((acc, a) => acc + a.amount, 0n);
        expect(sum).toBe(total);
    });

    it("should handle rounding in distribution", () => {
        const total = 10001n; // Odd number to test rounding
        const distributed = distributeAmount(total, mockAllocations);

        const sum = distributed.reduce((acc, a) => acc + a.amount, 0n);
        expect(sum).toBe(total);
    });

    it("should normalize weights to 100%", () => {
        const unbalanced = [
            { ...mockAllocations[0], weight: 40 },
            { ...mockAllocations[1], weight: 40 },
        ];

        const normalized = normalizeWeights(unbalanced);
        const totalWeight = normalized.reduce((sum, a) => sum + a.weight, 0);

        expect(Math.abs(totalWeight - 100)).toBeLessThan(0.01);
    });

    it("should handle three vaults", () => {
        const threeVaults: VaultAllocation[] = [
            { vaultContractId: "v1", vaultName: "A", apy: 10, weight: 33.33, amount: 0n },
            { vaultContractId: "v2", vaultName: "B", apy: 8, weight: 33.33, amount: 0n },
            { vaultContractId: "v3", vaultName: "C", apy: 12, weight: 33.34, amount: 0n },
        ];

        expect(isValidAllocation(threeVaults)).toBe(true);
        const apy = calculateBlendedApy(threeVaults);
        expect(apy).toBeCloseTo(10.0002, 2);
    });
});
