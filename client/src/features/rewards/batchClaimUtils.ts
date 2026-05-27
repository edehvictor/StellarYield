import type { BatchClaimPreview, VaultRewardStatus, ClaimProofData } from './types';

const PROOF_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const ESTIMATED_FEE_STROOPS = '1000000'; // 0.1 YIELD

/**
 * Check if a proof is stale (older than 24 hours)
 */
export function isProofStale(timestamp: number): boolean {
    return Date.now() - timestamp > PROOF_STALE_THRESHOLD_MS;
}

/**
 * Build a batch claim preview from multiple vault proofs
 */
export function buildBatchClaimPreview(
    vaultProofs: Record<string, ClaimProofData | null>,
    vaultMetadata: Record<string, { name: string }>,
): BatchClaimPreview {
    const vaults: VaultRewardStatus[] = [];
    let totalClaimable = 0n;
    let totalEstimatedFees = 0n;
    let allProofsAvailable = true;
    let anyProofsStale = false;

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

        const stale = isProofStale(proof.timestamp);
        const amount = BigInt(proof.amount);
        const fee = BigInt(ESTIMATED_FEE_STROOPS);

        totalClaimable += amount;
        totalEstimatedFees += fee;

        if (stale) {
            anyProofsStale = true;
        }

        vaults.push({
            vaultId,
            vaultName: metadata.name,
            claimableAmount: proof.amount,
            proofAvailable: true,
            proofStale: stale,
            lastProofUpdate: new Date(proof.timestamp).toISOString(),
            estimatedFee: fee.toString(),
            status: stale ? 'stale_proof' : 'claimable',
        });
    }

    return {
        totalClaimable: totalClaimable.toString(),
        totalEstimatedFees: totalEstimatedFees.toString(),
        vaults,
        allProofsAvailable,
        anyProofsStale,
        canClaimAll: allProofsAvailable && !anyProofsStale,
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
