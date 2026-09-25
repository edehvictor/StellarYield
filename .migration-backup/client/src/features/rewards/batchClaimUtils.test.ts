import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    isProofStale,
    buildBatchClaimPreview,
    formatYieldAmount,
    calculateTotalClaimable,
    getClaimableVaults,
    getStaleProofVaults,
    getUnavailableVaults,
    getInvalidProofVaults,
} from './batchClaimUtils';
import type { ClaimProofData, CurrentCampaignInfo } from './types';

describe('batchClaimUtils', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
    });

    describe('isProofStale', () => {
        it('returns false for recent proofs', () => {
            const recentTimestamp = Date.now() - 1000; // 1 second ago
            expect(isProofStale(recentTimestamp)).toBe(false);
        });

        it('returns false for proofs less than 24 hours old', () => {
            const timestamp = Date.now() - 12 * 60 * 60 * 1000; // 12 hours ago
            expect(isProofStale(timestamp)).toBe(false);
        });

        it('returns true for proofs older than 24 hours', () => {
            const timestamp = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
            expect(isProofStale(timestamp)).toBe(true);
        });

        it('returns true for proofs exactly 24 hours old', () => {
            const timestamp = Date.now() - 24 * 60 * 60 * 1000 - 1; // just over 24 hours
            expect(isProofStale(timestamp)).toBe(true);
        });
    });

    describe('buildBatchClaimPreview', () => {
        it('builds preview for fully claimable batch', () => {
            const vaultProofs = {
                vault1: {
                    index: 0,
                    amount: '5000000000',
                    proof: ['hash1'],
                    timestamp: Date.now() - 1000,
                } as ClaimProofData,
                vault2: {
                    index: 1,
                    amount: '3000000000',
                    proof: ['hash2'],
                    timestamp: Date.now() - 1000,
                } as ClaimProofData,
            };

            const vaultMetadata = {
                vault1: { name: 'USDC Vault' },
                vault2: { name: 'USDT Vault' },
            };

            const preview = buildBatchClaimPreview(vaultProofs, vaultMetadata);

            expect(preview.vaults).toHaveLength(2);
            expect(preview.allProofsAvailable).toBe(true);
            expect(preview.anyProofsStale).toBe(false);
            expect(preview.canClaimAll).toBe(true);
            expect(preview.totalClaimable).toBe('8000000000');
        });

        it('detects partially unavailable batch', () => {
            const vaultProofs = {
                vault1: {
                    index: 0,
                    amount: '5000000000',
                    proof: ['hash1'],
                    timestamp: Date.now() - 1000,
                } as ClaimProofData,
                vault2: null,
            };

            const vaultMetadata = {
                vault1: { name: 'USDC Vault' },
                vault2: { name: 'USDT Vault' },
            };

            const preview = buildBatchClaimPreview(vaultProofs, vaultMetadata);

            expect(preview.vaults).toHaveLength(2);
            expect(preview.allProofsAvailable).toBe(false);
            expect(preview.canClaimAll).toBe(false);

            const unavailable = preview.vaults.find(v => v.vaultId === 'vault2');
            expect(unavailable?.status).toBe('unavailable');
        });

        it('detects stale proofs', () => {
            const vaultProofs = {
                vault1: {
                    index: 0,
                    amount: '5000000000',
                    proof: ['hash1'],
                    timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
                } as ClaimProofData,
            };

            const vaultMetadata = {
                vault1: { name: 'USDC Vault' },
            };

            const preview = buildBatchClaimPreview(vaultProofs, vaultMetadata);

            expect(preview.anyProofsStale).toBe(true);
            expect(preview.canClaimAll).toBe(false);

            const staleVault = preview.vaults[0];
            expect(staleVault.proofStale).toBe(true);
            expect(staleVault.status).toBe('stale_proof');
        });

        it('calculates correct total fees', () => {
            const vaultProofs = {
                vault1: {
                    index: 0,
                    amount: '5000000000',
                    proof: ['hash1'],
                    timestamp: Date.now() - 1000,
                } as ClaimProofData,
                vault2: {
                    index: 1,
                    amount: '3000000000',
                    proof: ['hash2'],
                    timestamp: Date.now() - 1000,
                } as ClaimProofData,
                vault3: {
                    index: 2,
                    amount: '2000000000',
                    proof: ['hash3'],
                    timestamp: Date.now() - 1000,
                } as ClaimProofData,
            };

            const vaultMetadata = {
                vault1: { name: 'Vault 1' },
                vault2: { name: 'Vault 2' },
                vault3: { name: 'Vault 3' },
            };

            const preview = buildBatchClaimPreview(vaultProofs, vaultMetadata);

            // 3 vaults * 1000000 stroops per vault = 3000000 stroops
            expect(preview.totalEstimatedFees).toBe('3000000');
        });

        it('handles empty vault proofs', () => {
            const preview = buildBatchClaimPreview({}, {});

            expect(preview.vaults).toHaveLength(0);
            expect(preview.totalClaimable).toBe('0');
            expect(preview.allProofsAvailable).toBe(true);
            expect(preview.canClaimAll).toBe(true);
        });
    });

    describe('formatYieldAmount', () => {
        it('formats stroops to YIELD correctly', () => {
            expect(formatYieldAmount('10000000')).toBe('1');
            expect(formatYieldAmount('50000000')).toBe('5');
            expect(formatYieldAmount('1234567')).toBe('0.1234567');
        });

        it('removes trailing zeros', () => {
            expect(formatYieldAmount('10000000')).toBe('1');
            expect(formatYieldAmount('10100000')).toBe('1.01');
        });

        it('handles zero amount', () => {
            expect(formatYieldAmount('0')).toBe('0');
        });

        it('handles large amounts', () => {
            expect(formatYieldAmount('1000000000000')).toBe('100000');
        });
    });

    describe('calculateTotalClaimable', () => {
        it('sums claimable amounts across vaults', () => {
            const vaults = [
                {
                    vaultId: 'v1',
                    vaultName: 'Vault 1',
                    claimableAmount: '5000000000',
                    proofAvailable: true,
                    proofStale: false,
                    lastProofUpdate: null,
                    estimatedFee: '1000000',
                    status: 'claimable' as const,
                },
                {
                    vaultId: 'v2',
                    vaultName: 'Vault 2',
                    claimableAmount: '3000000000',
                    proofAvailable: true,
                    proofStale: false,
                    lastProofUpdate: null,
                    estimatedFee: '1000000',
                    status: 'claimable' as const,
                },
            ];

            const total = calculateTotalClaimable(vaults);
            expect(total).toBe(8000000000n);
        });

        it('returns 0 for empty vault list', () => {
            const total = calculateTotalClaimable([]);
            expect(total).toBe(0n);
        });
    });

    describe('getClaimableVaults', () => {
        it('filters only claimable vaults', () => {
            const vaults = [
                {
                    vaultId: 'v1',
                    vaultName: 'Vault 1',
                    claimableAmount: '5000000000',
                    proofAvailable: true,
                    proofStale: false,
                    lastProofUpdate: null,
                    estimatedFee: '1000000',
                    status: 'claimable' as const,
                },
                {
                    vaultId: 'v2',
                    vaultName: 'Vault 2',
                    claimableAmount: '3000000000',
                    proofAvailable: true,
                    proofStale: true,
                    lastProofUpdate: null,
                    estimatedFee: '1000000',
                    status: 'stale_proof' as const,
                },
            ];

            const claimable = getClaimableVaults(vaults);
            expect(claimable).toHaveLength(1);
            expect(claimable[0].vaultId).toBe('v1');
        });
    });

    describe('getStaleProofVaults', () => {
        it('filters vaults with stale proofs', () => {
            const vaults = [
                {
                    vaultId: 'v1',
                    vaultName: 'Vault 1',
                    claimableAmount: '5000000000',
                    proofAvailable: true,
                    proofStale: false,
                    lastProofUpdate: null,
                    estimatedFee: '1000000',
                    status: 'claimable' as const,
                },
                {
                    vaultId: 'v2',
                    vaultName: 'Vault 2',
                    claimableAmount: '3000000000',
                    proofAvailable: true,
                    proofStale: true,
                    lastProofUpdate: null,
                    estimatedFee: '1000000',
                    status: 'stale_proof' as const,
                },
            ];

            const stale = getStaleProofVaults(vaults);
            expect(stale).toHaveLength(1);
            expect(stale[0].vaultId).toBe('v2');
        });
    });

    describe('getUnavailableVaults', () => {
        it('filters vaults without proofs', () => {
            const vaults = [
                {
                    vaultId: 'v1',
                    vaultName: 'Vault 1',
                    claimableAmount: '5000000000',
                    proofAvailable: true,
                    proofStale: false,
                    lastProofUpdate: null,
                    estimatedFee: '1000000',
                    status: 'claimable' as const,
                },
                {
                    vaultId: 'v2',
                    vaultName: 'Vault 2',
                    claimableAmount: '0',
                    proofAvailable: false,
                    proofStale: false,
                    lastProofUpdate: null,
                    estimatedFee: '0',
                    status: 'unavailable' as const,
                },
            ];

            const unavailable = getUnavailableVaults(vaults);
            expect(unavailable).toHaveLength(1);
            expect(unavailable[0].vaultId).toBe('v2');
        });
    });

    // ── #964: campaign-aware buildBatchClaimPreview ────────────────────────

    describe('buildBatchClaimPreview with currentCampaign', () => {
        const currentCampaign: CurrentCampaignInfo = {
            campaignId: '2026-W22',
            merkleRoot: 'a'.repeat(64),
        };

        it('keeps a matching campaign/root proof claimable', () => {
            const vaultProofs = {
                vault1: {
                    index: 0,
                    amount: '5000000000',
                    proof: ['b'.repeat(64)],
                    timestamp: Date.now() - 1000,
                    campaignId: '2026-W22',
                    merkleRoot: 'a'.repeat(64),
                } as ClaimProofData,
            };
            const vaultMetadata = { vault1: { name: 'USDC Vault' } };

            const preview = buildBatchClaimPreview(vaultProofs, vaultMetadata, currentCampaign);

            expect(preview.vaults[0].status).toBe('claimable');
            expect(preview.canClaimAll).toBe(true);
        });

        it('marks a campaign-ID mismatch as invalid_proof, not stale', () => {
            const vaultProofs = {
                vault1: {
                    index: 0,
                    amount: '5000000000',
                    proof: ['b'.repeat(64)],
                    timestamp: Date.now() - 1000,
                    campaignId: '2026-W21',
                    merkleRoot: 'a'.repeat(64),
                } as ClaimProofData,
            };
            const vaultMetadata = { vault1: { name: 'USDC Vault' } };

            const preview = buildBatchClaimPreview(vaultProofs, vaultMetadata, currentCampaign);

            expect(preview.vaults[0].status).toBe('invalid_proof');
            expect(preview.vaults[0].proofStale).toBe(false);
            expect(preview.vaults[0].previewMessage).toMatch(/campaign/i);
            expect(preview.canClaimAll).toBe(false);
            expect(getInvalidProofVaults(preview.vaults)).toHaveLength(1);
        });

        it('marks root drift as stale_proof', () => {
            const vaultProofs = {
                vault1: {
                    index: 0,
                    amount: '5000000000',
                    proof: ['b'.repeat(64)],
                    timestamp: Date.now() - 1000,
                    campaignId: '2026-W22',
                    merkleRoot: 'c'.repeat(64),
                } as ClaimProofData,
            };
            const vaultMetadata = { vault1: { name: 'USDC Vault' } };

            const preview = buildBatchClaimPreview(vaultProofs, vaultMetadata, currentCampaign);

            expect(preview.vaults[0].status).toBe('stale_proof');
            expect(preview.vaults[0].proofStale).toBe(true);
            expect(preview.anyProofsStale).toBe(true);
            expect(preview.canClaimAll).toBe(false);
        });

        it('marks a malformed proof array as invalid_proof', () => {
            const vaultProofs = {
                vault1: {
                    index: 0,
                    amount: '5000000000',
                    proof: ['not-a-hex-hash'],
                    timestamp: Date.now() - 1000,
                    campaignId: '2026-W22',
                    merkleRoot: 'a'.repeat(64),
                } as ClaimProofData,
            };
            const vaultMetadata = { vault1: { name: 'USDC Vault' } };

            const preview = buildBatchClaimPreview(vaultProofs, vaultMetadata, currentCampaign);

            expect(preview.vaults[0].status).toBe('invalid_proof');
            expect(preview.canClaimAll).toBe(false);
        });

        it('does not run campaign checks when currentCampaign is omitted (backward compatible)', () => {
            const vaultProofs = {
                vault1: {
                    index: 0,
                    amount: '5000000000',
                    proof: ['not-a-hex-hash'],
                    timestamp: Date.now() - 1000,
                    campaignId: 'some-other-campaign',
                    merkleRoot: 'z'.repeat(64),
                } as ClaimProofData,
            };
            const vaultMetadata = { vault1: { name: 'USDC Vault' } };

            const preview = buildBatchClaimPreview(vaultProofs, vaultMetadata);

            expect(preview.vaults[0].status).toBe('claimable');
        });
    });
});
