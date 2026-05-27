/**
 * Types for multi-vault rewards claiming
 */

export interface VaultRewardStatus {
    vaultId: string;
    vaultName: string;
    claimableAmount: string;
    proofAvailable: boolean;
    proofStale: boolean;
    lastProofUpdate: string | null;
    estimatedFee: string;
    status: 'claimable' | 'unavailable' | 'stale_proof';
}

export interface BatchClaimPreview {
    totalClaimable: string;
    totalEstimatedFees: string;
    vaults: VaultRewardStatus[];
    allProofsAvailable: boolean;
    anyProofsStale: boolean;
    canClaimAll: boolean;
}

export interface ClaimProofData {
    index: number;
    amount: string;
    proof: string[];
    timestamp: number;
}
