/**
 * Multi-Vault Portfolio Builder Types
 */

export interface VaultAllocation {
    vaultContractId: string;
    vaultName: string;
    apy: number;
    weight: number; // 0-100, sum must equal 100
    amount: bigint;
}

export interface PortfolioAllocation {
    totalAmount: bigint;
    allocations: VaultAllocation[];
    blendedApy: number;
    createdAt: number;
}

export interface PortfolioState {
    totalAmount: string;
    allocations: VaultAllocation[];
    blendedApy: number;
    isValid: boolean;
}
