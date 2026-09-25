/**
 * Portfolio Builder Utilities
 * Handles allocation calculations and validation
 */

import type { VaultAllocation, PortfolioAllocation, PortfolioPreset } from "./types";

const EPSILON = 1e-9; // Floating-point tolerance

/**
 * Apply a portfolio allocation preset
 */
export function applyPreset(
    availableVaults: Array<{ contractId: string; name: string; apy: number }>,
    preset: PortfolioPreset,
): VaultAllocation[] {
    if (availableVaults.length === 0) return [];

    // Sort by APY (ascending: safer -> riskier)
    const sortedVaults = [...availableVaults].sort((a, b) => a.apy - b.apy);
    const n = sortedVaults.length;
    let weights: number[] = [];

    switch (preset) {
        case "conservative":
            if (n === 1) weights = [100];
            else if (n === 2) weights = [70, 30];
            else weights = [60, 30, ...new Array(n - 2).fill(10 / (n - 2))];
            break;
        case "balanced":
            weights = new Array(n).fill(100 / n);
            break;
        case "aggressive":
            if (n === 1) weights = [100];
            else if (n === 2) weights = [30, 70];
            else {
                const others = new Array(n - 1).fill(40 / (n - 1));
                weights = [...others, 60];
            }
            break;
        case "stablecoin-heavy":
            weights = [100, ...new Array(n - 1).fill(0)];
            break;
        default:
            weights = new Array(n).fill(100 / n);
    }

    const allocations = sortedVaults.map((v, i) => ({
        vaultContractId: v.contractId,
        vaultName: v.name,
        apy: v.apy,
        weight: weights[i],
        amount: 0n,
    }));

    return normalizeWeights(allocations);
}

/**
 * Calculate blended APY from weighted allocations
 */
export function calculateBlendedApy(allocations: VaultAllocation[]): number {
    const totalWeight = allocations.reduce((sum, a) => sum + a.weight, 0);
    if (Math.abs(totalWeight - 100) > EPSILON) return 0;

    return allocations.reduce((sum, a) => sum + (a.apy * a.weight) / 100, 0);
}

/**
 * Validate that weights sum to 100% (with floating-point tolerance)
 */
export function isValidAllocation(allocations: VaultAllocation[]): boolean {
    const totalWeight = allocations.reduce((sum, a) => sum + a.weight, 0);
    return Math.abs(totalWeight - 100) < EPSILON;
}

/**
 * Distribute total amount across allocations based on weights
 * Handles rounding to prevent dust
 */
export function distributeAmount(
    totalAmount: bigint,
    allocations: VaultAllocation[],
): VaultAllocation[] {
    if (!isValidAllocation(allocations)) {
        throw new Error("Allocations must sum to 100%");
    }

    const distributed = allocations.map((alloc) => {
        const amount = (totalAmount * BigInt(Math.round(alloc.weight * 100))) / BigInt(10000);
        return { ...alloc, amount };
    });

    // Handle rounding: add remainder to largest allocation
    const totalDistributed = distributed.reduce((sum, a) => sum + a.amount, 0n);
    const remainder = totalAmount - totalDistributed;

    if (remainder !== 0n) {
        const largestIdx = distributed.reduce((maxIdx, a, i) =>
            a.amount > distributed[maxIdx].amount ? i : maxIdx,
            0,
        );
        distributed[largestIdx].amount += remainder;
    }

    return distributed;
}

/**
 * Normalize weights to sum to exactly 100
 */
export function normalizeWeights(allocations: VaultAllocation[]): VaultAllocation[] {
    const totalWeight = allocations.reduce((sum, a) => sum + a.weight, 0);
    if (totalWeight === 0) return allocations;

    const normalized = allocations.map((a) => ({
        ...a,
        weight: (a.weight / totalWeight) * 100,
    }));

    // Fix small floating point errors to ensure they sum to exactly 100
    const sum = normalized.reduce((s, a) => s + a.weight, 0);
    if (sum !== 100) {
        normalized[0].weight += (100 - sum);
    }

    return normalized;
}

/**
 * Create portfolio allocation record
 */
export function createPortfolioAllocation(
    totalAmount: bigint,
    allocations: VaultAllocation[],
): PortfolioAllocation {
    const distributed = distributeAmount(totalAmount, allocations);
    return {
        totalAmount,
        allocations: distributed,
        blendedApy: calculateBlendedApy(distributed),
        createdAt: Date.now(),
    };
}
