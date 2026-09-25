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
    status: 'claimable' | 'unavailable' | 'stale_proof' | 'invalid_proof';
    /** Human-readable reason when status is 'invalid_proof' (#964). */
    previewMessage?: string;
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
    /** Distribution campaign this proof was generated for (#964). */
    campaignId?: string;
    /** Merkle root this proof was generated against (#964). */
    merkleRoot?: string;
}

/**
 * The active reward campaign's canonical id and Merkle root, used to detect
 * campaign-ID mismatches and root drift in cached claim proofs (#964).
 */
export interface CurrentCampaignInfo {
    campaignId: string;
    merkleRoot: string;
}

export type ClaimPreviewState = 'valid' | 'invalid' | 'stale';

export type ClaimPreviewErrorCode =
    | 'campaign_id_mismatch'
    | 'malformed_proof'
    | 'root_mismatch';

export interface ClaimPreviewResult {
    state: ClaimPreviewState;
    errorCode?: ClaimPreviewErrorCode;
    message: string;
}
