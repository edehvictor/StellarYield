/**
 * Vault Capacity Service
 * Models vault capacity and soft deposit limits
 */

export interface CapacityInputs {
    tvl: bigint; // Total Value Locked in stroops
    liquidityDepth: bigint; // Available liquidity in stroops
    maxDepositSize: bigint; // Maximum single deposit in stroops
    softCapacity: bigint; // Soft capacity threshold in stroops
}

export interface CapacityStatus {
    vaultId: string;
    currentUtilization: number; // 0-100 percentage
    isNearCapacity: boolean; // > 80% utilization
    isAtCapacity: boolean; // >= 100% utilization
    availableCapacity: bigint;
    recommendedMaxDeposit: bigint;
    status: 'normal' | 'near_capacity' | 'over_capacity';
    warnings: string[];
}

export interface DepositLimitWarning {
    vaultId: string;
    depositAmount: bigint;
    wouldExceedCapacity: boolean;
    wouldCauseNearCapacity: boolean;
    estimatedUtilizationAfter: number;
    message: string;
}

const NEAR_CAPACITY_THRESHOLD = 0.8; // 80%
const CAPACITY_THRESHOLD = 1.0; // 100%

/**
 * Calculate vault capacity status
 */
export function calculateCapacityStatus(
    vaultId: string,
    inputs: CapacityInputs,
): CapacityStatus {
    const utilization = inputs.softCapacity > 0n
        ? Number(inputs.tvl * BigInt(100)) / Number(inputs.softCapacity)
        : 0;

    const isNearCapacity = utilization >= NEAR_CAPACITY_THRESHOLD * 100;
    const isAtCapacity = utilization >= CAPACITY_THRESHOLD * 100;

    const availableCapacity = inputs.softCapacity > inputs.tvl
        ? inputs.softCapacity - inputs.tvl
        : 0n;

    const recommendedMaxDeposit = calculateRecommendedMaxDeposit(
        inputs,
        utilization,
    );

    const warnings: string[] = [];

    if (isAtCapacity) {
        warnings.push('Vault is at or exceeding soft capacity');
    } else if (isNearCapacity) {
        warnings.push('Vault is approaching capacity');
    }

    if (inputs.liquidityDepth < inputs.tvl * BigInt(10)) {
        warnings.push('Liquidity depth is low relative to TVL');
    }

    return {
        vaultId,
        currentUtilization: Math.min(utilization, 200), // Cap at 200% for display
        isNearCapacity,
        isAtCapacity,
        availableCapacity,
        recommendedMaxDeposit,
        status: isAtCapacity ? 'over_capacity' : isNearCapacity ? 'near_capacity' : 'normal',
        warnings,
    };
}

/**
 * Calculate recommended maximum deposit based on capacity
 */
function calculateRecommendedMaxDeposit(
    inputs: CapacityInputs,
    currentUtilization: number,
): bigint {
    // If over capacity, recommend 0
    if (currentUtilization >= CAPACITY_THRESHOLD * 100) {
        return 0n;
    }

    // If near capacity, recommend small deposits
    if (currentUtilization >= NEAR_CAPACITY_THRESHOLD * 100) {
        const availableCapacity = inputs.softCapacity > inputs.tvl
            ? inputs.softCapacity - inputs.tvl
            : 0n;
        // Recommend 10% of available capacity
        return availableCapacity / BigInt(10);
    }

    // Otherwise, recommend up to max deposit size or 50% of available capacity
    const availableCapacity = inputs.softCapacity > inputs.tvl
        ? inputs.softCapacity - inputs.tvl
        : 0n;

    const maxRecommended = availableCapacity / BigInt(2);
    return maxRecommended < inputs.maxDepositSize
        ? maxRecommended
        : inputs.maxDepositSize;
}

/**
 * Check if a deposit would violate capacity limits
 */
export function checkDepositAgainstCapacity(
    vaultId: string,
    depositAmount: bigint,
    inputs: CapacityInputs,
): DepositLimitWarning {
    const newTvl = inputs.tvl + depositAmount;
    const newUtilization = inputs.softCapacity > 0n
        ? Number(newTvl * BigInt(100)) / Number(inputs.softCapacity)
        : 0;

    const wouldExceedCapacity = newUtilization > CAPACITY_THRESHOLD * 100;
    const wouldCauseNearCapacity = newUtilization >= NEAR_CAPACITY_THRESHOLD * 100;

    let message = '';

    if (wouldExceedCapacity) {
        message = `Deposit of ${depositAmount} stroops would exceed vault capacity. Current utilization: ${newUtilization.toFixed(1)}%`;
    } else if (wouldCauseNearCapacity) {
        message = `Deposit of ${depositAmount} stroops would bring vault near capacity. Utilization would be ${newUtilization.toFixed(1)}%`;
    }

    return {
        vaultId,
        depositAmount,
        wouldExceedCapacity,
        wouldCauseNearCapacity,
        estimatedUtilizationAfter: newUtilization,
        message,
    };
}

/**
 * Get capacity status for multiple vaults
 */
export function getMultiVaultCapacityStatus(
    vaults: Array<{ vaultId: string; inputs: CapacityInputs }>,
): CapacityStatus[] {
    return vaults.map(({ vaultId, inputs }) =>
        calculateCapacityStatus(vaultId, inputs),
    );
}

/**
 * Filter vaults by capacity status
 */
export function filterVaultsByStatus(
    vaults: CapacityStatus[],
    status: 'normal' | 'near_capacity' | 'over_capacity',
): CapacityStatus[] {
    return vaults.filter(v => v.status === status);
}
