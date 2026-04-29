/**
 * Portfolio Builder Utilities
 * Handles allocation calculations and validation
 */

import type { VaultAllocation, PortfolioAllocation } from "./types";

const EPSILON = 1e-9; // Floating-point tolerance

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

    return allocations.map((a) => ({
        ...a,
        weight: (a.weight / totalWeight) * 100,
    }));
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
