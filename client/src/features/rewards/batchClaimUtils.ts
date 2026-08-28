import type { BatchClaimPreview, VaultRewardStatus, ClaimProofData, CurrentCampaignInfo } from './types';
import { getClaimPreviewState } from './claimPreviewValidation';

const PROOF_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const ESTIMATED_FEE_STROOPS = '1000000'; // 0.1 YIELD

/** Maximum number of vaults processed in a single batch claim preview page. */
export const MAX_VAULTS_PER_PAGE = 50;

export interface PaginatedBatchResult {
    vaults: VaultRewardStatus[];
    page: number;
    pageSize: number;
    totalVaults: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
}

/**
 * Paginate a flat vault list for batch-claim previews.
 * Page is 1-indexed. Clamps pageSize to [1, MAX_VAULTS_PER_PAGE].
 */
export function paginateVaultResults(
    vaults: VaultRewardStatus[],
    page: number,
    pageSize: number = MAX_VAULTS_PER_PAGE,
): PaginatedBatchResult {
    const clampedPageSize = Math.min(Math.max(1, Math.floor(pageSize)), MAX_VAULTS_PER_PAGE);
    const clampedPage = Math.max(1, Math.floor(page));
    const totalVaults = vaults.length;
    const totalPages = totalVaults === 0 ? 1 : Math.ceil(totalVaults / clampedPageSize);
    const safePage = Math.min(clampedPage, totalPages);
    const start = (safePage - 1) * clampedPageSize;
    const end = start + clampedPageSize;

    return {
        vaults: vaults.slice(start, end),
        page: safePage,
        pageSize: clampedPageSize,
        totalVaults,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1,
    };
}

/**
 * Check if a proof is stale (older than 24 hours)
 */
export function isProofStale(timestamp: number): boolean {
    return Date.now() - timestamp > PROOF_STALE_THRESHOLD_MS;
}

/**
 * Build a batch claim preview from multiple vault proofs.
 *
 * When `currentCampaign` is provided, each proof is additionally checked
 * against the active campaign's id and Merkle root (#964): a campaign-ID
 * mismatch or malformed proof marks the vault 'invalid_proof' (must not be
 * submitted), while root drift is folded into the existing 'stale_proof'
 * signal alongside time-based staleness.
 */
export function buildBatchClaimPreview(
    vaultProofs: Record<string, ClaimProofData | null>,
    vaultMetadata: Record<string, { name: string }>,
    currentCampaign?: CurrentCampaignInfo,
): BatchClaimPreview {
    const vaults: VaultRewardStatus[] = [];
    let totalClaimable = 0n;
    let totalEstimatedFees = 0n;
    let allProofsAvailable = true;
    let anyProofsStale = false;
    let anyProofsInvalid = false;

    for (const [vaultId, proof] of Object.entries(vaultProofs)) {
        const metadata = vaultMetadata[vaultId];
        if (!metadata) continue;

        if (!proof) {
            vaults.push({
                vaultId,
                vaultName: metadata.name,
                claimableAmount: '0',
                proofAvailable: false,
                proofStale: false,
                lastProofUpdate: null,
                estimatedFee: '0',
                status: 'unavailable',
            });
            allProofsAvailable = false;
            continue;
        }

        const preview = currentCampaign
            ? getClaimPreviewState(
                { campaignId: proof.campaignId, merkleRoot: proof.merkleRoot, proof: proof.proof },
                currentCampaign,
            )
            : null;

        const timeStale = isProofStale(proof.timestamp);
        const rootStale = preview?.state === 'stale';
        const invalid = preview?.state === 'invalid';
        const stale = timeStale || rootStale;

        const amount = BigInt(proof.amount);
        const fee = BigInt(ESTIMATED_FEE_STROOPS);

        totalClaimable += amount;
        totalEstimatedFees += fee;

        if (invalid) {
            anyProofsInvalid = true;
        } else if (stale) {
            anyProofsStale = true;
        }

        vaults.push({
            vaultId,
            vaultName: metadata.name,
            claimableAmount: proof.amount,
            proofAvailable: true,
            proofStale: stale && !invalid,
            lastProofUpdate: new Date(proof.timestamp).toISOString(),
            estimatedFee: fee.toString(),
            status: invalid ? 'invalid_proof' : stale ? 'stale_proof' : 'claimable',
            previewMessage: invalid ? preview?.message : undefined,
        });
    }

    return {
        totalClaimable: totalClaimable.toString(),
        totalEstimatedFees: totalEstimatedFees.toString(),
        vaults,
        allProofsAvailable,
        anyProofsStale,
        canClaimAll: allProofsAvailable && !anyProofsStale && !anyProofsInvalid,
    };
}

/**
 * Format stroops to YIELD amount
 */
export function formatYieldAmount(stroops: string): string {
    const value = BigInt(stroops);
    const whole = value / BigInt(10_000_000);
    const fractional = value % BigInt(10_000_000);
    const fracStr = fractional.toString().padStart(7, '0').replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

/**
 * Calculate total claimable across all vaults
 */
export function calculateTotalClaimable(vaults: VaultRewardStatus[]): bigint {
    return vaults.reduce((sum, vault) => sum + BigInt(vault.claimableAmount), 0n);
}

/**
 * Get vaults that can be claimed immediately
 */
export function getClaimableVaults(vaults: VaultRewardStatus[]): VaultRewardStatus[] {
    return vaults.filter(v => v.status === 'claimable');
}

/**
 * Get vaults with stale proofs
 */
export function getStaleProofVaults(vaults: VaultRewardStatus[]): VaultRewardStatus[] {
    return vaults.filter(v => v.proofStale);
}

/**
 * Get vaults with missing proofs
 */
export function getUnavailableVaults(vaults: VaultRewardStatus[]): VaultRewardStatus[] {
    return vaults.filter(v => !v.proofAvailable);
}

/**
 * Get vaults whose cached proof failed campaign-ID or shape validation and
 * must not be submitted as-is (#964).
 */
export function getInvalidProofVaults(vaults: VaultRewardStatus[]): VaultRewardStatus[] {
    return vaults.filter(v => v.status === 'invalid_proof');
}
