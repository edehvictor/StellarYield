/**
 * batchClaimPagination.test.ts — Issue #830
 *
 * Covers pagination of large reward batches and safe degradation for
 * oversized inputs in the client-side batch-claim preview layer:
 *
 * 1. paginateVaultResults pages a large vault list correctly.
 * 2. pageSize is clamped to [1, MAX_VAULTS_PER_PAGE].
 * 3. Out-of-range page numbers are clamped safely (no empty results crash).
 * 4. Large batches (> MAX_VAULTS_PER_PAGE) do not overflow a single page.
 * 5. Pagination metadata (totalPages, hasNextPage, hasPrevPage) is accurate.
 * 6. buildBatchClaimPreview handles large vault sets without data loss.
 * 7. Oversized proof timestamps and amounts degrade gracefully.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    paginateVaultResults,
    buildBatchClaimPreview,
    MAX_VAULTS_PER_PAGE,
    calculateTotalClaimable,
    getClaimableVaults,
} from './batchClaimUtils';
import type { VaultRewardStatus, ClaimProofData } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVault(id: number, status: VaultRewardStatus['status'] = 'claimable'): VaultRewardStatus {
    return {
        vaultId: `vault-${id}`,
        vaultName: `Vault ${id}`,
        claimableAmount: (id * 1_000_000).toString(),
        proofAvailable: status !== 'unavailable',
        proofStale: status === 'stale_proof',
        lastProofUpdate: status !== 'unavailable' ? new Date().toISOString() : null,
        estimatedFee: '1000000',
        status,
    };
}

function makeVaults(count: number, status: VaultRewardStatus['status'] = 'claimable'): VaultRewardStatus[] {
    return Array.from({ length: count }, (_, i) => makeVault(i + 1, status));
}

function makeProof(id: number, overrides: Partial<ClaimProofData> = {}): ClaimProofData {
    return {
        index: id,
        amount: (id * 1_000_000).toString(),
        proof: [`hash${id}`],
        timestamp: Date.now() - 1000,
        ...overrides,
    };
}

// ── 1. paginateVaultResults — basic pagination ────────────────────────────────

describe('paginateVaultResults', () => {
    const vaults = makeVaults(120);

    it('returns the first page with default page size', () => {
        const result = paginateVaultResults(vaults, 1);
        expect(result.vaults).toHaveLength(MAX_VAULTS_PER_PAGE);
        expect(result.page).toBe(1);
        expect(result.pageSize).toBe(MAX_VAULTS_PER_PAGE);
        expect(result.totalVaults).toBe(120);
        expect(result.hasNextPage).toBe(true);
        expect(result.hasPrevPage).toBe(false);
    });

    it('returns the last partial page correctly', () => {
        // 120 vaults / 50 per page = 2 full pages + 1 page of 20
        const result = paginateVaultResults(vaults, 3);
        expect(result.vaults).toHaveLength(20);
        expect(result.hasNextPage).toBe(false);
        expect(result.hasPrevPage).toBe(true);
    });

    it('returns correct page 2 slice', () => {
        const result = paginateVaultResults(vaults, 2);
        expect(result.vaults[0].vaultId).toBe('vault-51');
        expect(result.vaults[result.vaults.length - 1].vaultId).toBe('vault-100');
    });

    it('returns correct total pages', () => {
        const result = paginateVaultResults(vaults, 1);
        expect(result.totalPages).toBe(3); // ceil(120 / 50)
    });

    it('returns all items on page 1 when count ≤ MAX_VAULTS_PER_PAGE', () => {
        const small = makeVaults(10);
        const result = paginateVaultResults(small, 1);
        expect(result.vaults).toHaveLength(10);
        expect(result.totalPages).toBe(1);
        expect(result.hasNextPage).toBe(false);
    });

    it('handles empty vault list without error', () => {
        const result = paginateVaultResults([], 1);
        expect(result.vaults).toHaveLength(0);
        expect(result.totalVaults).toBe(0);
        expect(result.totalPages).toBe(1);
        expect(result.hasNextPage).toBe(false);
        expect(result.hasPrevPage).toBe(false);
    });

    it('respects a custom smaller page size', () => {
        const result = paginateVaultResults(vaults, 1, 10);
        expect(result.vaults).toHaveLength(10);
        expect(result.totalPages).toBe(12);
        expect(result.pageSize).toBe(10);
    });
});

// ── 2. pageSize clamping ──────────────────────────────────────────────────────

describe('paginateVaultResults — pageSize clamping', () => {
    const vaults = makeVaults(200);

    it('clamps pageSize above MAX_VAULTS_PER_PAGE to MAX_VAULTS_PER_PAGE', () => {
        const result = paginateVaultResults(vaults, 1, MAX_VAULTS_PER_PAGE + 1000);
        expect(result.pageSize).toBe(MAX_VAULTS_PER_PAGE);
        expect(result.vaults).toHaveLength(MAX_VAULTS_PER_PAGE);
    });

    it('clamps pageSize of 0 to 1', () => {
        const result = paginateVaultResults(vaults, 1, 0);
        expect(result.pageSize).toBe(1);
        expect(result.vaults).toHaveLength(1);
    });

    it('clamps negative pageSize to 1', () => {
        const result = paginateVaultResults(vaults, 1, -99);
        expect(result.pageSize).toBe(1);
        expect(result.vaults).toHaveLength(1);
    });
});

// ── 3. Out-of-range page numbers ──────────────────────────────────────────────

describe('paginateVaultResults — out-of-range page numbers', () => {
    const vaults = makeVaults(75); // 2 pages of 50 max

    it('clamps page 0 to page 1', () => {
        const result = paginateVaultResults(vaults, 0);
        expect(result.page).toBe(1);
        expect(result.vaults).toHaveLength(MAX_VAULTS_PER_PAGE);
    });

    it('clamps negative page to page 1', () => {
        const result = paginateVaultResults(vaults, -5);
        expect(result.page).toBe(1);
    });

    it('clamps an out-of-bounds high page to the last page', () => {
        const result = paginateVaultResults(vaults, 999);
        expect(result.page).toBe(2);
        expect(result.vaults).toHaveLength(25); // 75 - 50 = 25 remaining
        expect(result.hasNextPage).toBe(false);
    });
});

// ── 4. Large batches do not overflow a single page ────────────────────────────

describe('large batch overflow protection', () => {
    it('a batch of 500 vaults never returns more than MAX_VAULTS_PER_PAGE per call', () => {
        const vaults = makeVaults(500);
        for (let page = 1; page <= 10; page++) {
            const result = paginateVaultResults(vaults, page);
            expect(result.vaults.length).toBeLessThanOrEqual(MAX_VAULTS_PER_PAGE);
        }
    });

    it('iterating all pages of a 500-vault list covers every vault exactly once', () => {
        const vaults = makeVaults(500);
        const seen = new Set<string>();
        let page = 1;

        while (true) {
            const result = paginateVaultResults(vaults, page);
            for (const v of result.vaults) {
                expect(seen.has(v.vaultId)).toBe(false); // no duplicates
                seen.add(v.vaultId);
            }
            if (!result.hasNextPage) break;
            page++;
        }

        expect(seen.size).toBe(500);
    });
});

// ── 5. Pagination metadata accuracy ──────────────────────────────────────────

describe('pagination metadata', () => {
    it.each([
        { count: 1,   pageSize: 10, expectedPages: 1 },
        { count: 10,  pageSize: 10, expectedPages: 1 },
        { count: 11,  pageSize: 10, expectedPages: 2 },
        { count: 50,  pageSize: 50, expectedPages: 1 },
        { count: 51,  pageSize: 50, expectedPages: 2 },
        { count: 100, pageSize: 50, expectedPages: 2 },
        { count: 101, pageSize: 50, expectedPages: 3 },
    ])('$count vaults / $pageSize per page = $expectedPages pages', ({ count, pageSize, expectedPages }) => {
        const vaults = makeVaults(count);
        const result = paginateVaultResults(vaults, 1, pageSize);
        expect(result.totalPages).toBe(expectedPages);
    });

    it('hasNextPage is false on the last page', () => {
        const vaults = makeVaults(55); // 2 pages: 50 + 5
        const last = paginateVaultResults(vaults, 2);
        expect(last.hasNextPage).toBe(false);
        expect(last.hasPrevPage).toBe(true);
    });

    it('hasPrevPage is false on the first page', () => {
        const vaults = makeVaults(55);
        const first = paginateVaultResults(vaults, 1);
        expect(first.hasPrevPage).toBe(false);
        expect(first.hasNextPage).toBe(true);
    });
});

// ── 6. buildBatchClaimPreview with large vault sets ──────────────────────────

describe('buildBatchClaimPreview — large vault sets', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-06-01T00:00:00Z'));
    });

    it('handles 100-vault batch and sums fees correctly', () => {
        const proofs: Record<string, ClaimProofData> = {};
        const metadata: Record<string, { name: string }> = {};

        for (let i = 0; i < 100; i++) {
            const id = `vault-${i}`;
            proofs[id] = makeProof(i);
            metadata[id] = { name: `Vault ${i}` };
        }

        const preview = buildBatchClaimPreview(proofs, metadata);

        expect(preview.vaults).toHaveLength(100);
        expect(preview.allProofsAvailable).toBe(true);
        expect(preview.anyProofsStale).toBe(false);
        // Each vault contributes 1_000_000 stroops in fees
        expect(BigInt(preview.totalEstimatedFees)).toBe(BigInt(100) * BigInt(1_000_000));
    });

    it('counts unavailable and stale proofs correctly in a mixed large batch', () => {
        const proofs: Record<string, ClaimProofData | null> = {};
        const metadata: Record<string, { name: string }> = {};

        for (let i = 0; i < 60; i++) {
            const id = `vault-${i}`;
            metadata[id] = { name: `Vault ${i}` };

            if (i < 20) {
                proofs[id] = makeProof(i); // claimable
            } else if (i < 40) {
                proofs[id] = makeProof(i, { timestamp: Date.now() - 25 * 60 * 60 * 1000 }); // stale
            } else {
                proofs[id] = null; // unavailable
            }
        }

        const preview = buildBatchClaimPreview(proofs, metadata);

        expect(preview.vaults).toHaveLength(60);
        expect(preview.allProofsAvailable).toBe(false);
        expect(preview.anyProofsStale).toBe(true);
        expect(preview.canClaimAll).toBe(false);

        const claimable = preview.vaults.filter(v => v.status === 'claimable');
        const stale = preview.vaults.filter(v => v.status === 'stale_proof');
        const unavailable = preview.vaults.filter(v => v.status === 'unavailable');

        expect(claimable).toHaveLength(20);
        expect(stale).toHaveLength(20);
        expect(unavailable).toHaveLength(20);
    });

    it('totalClaimable across a large batch matches sum of individual amounts', () => {
        const proofs: Record<string, ClaimProofData> = {};
        const metadata: Record<string, { name: string }> = {};
        let expectedTotal = 0n;

        for (let i = 1; i <= 80; i++) {
            const id = `vault-${i}`;
            const amount = BigInt(i) * BigInt(1_000_000);
            proofs[id] = { index: i, amount: amount.toString(), proof: [`h${i}`], timestamp: Date.now() - 100 };
            metadata[id] = { name: `Vault ${i}` };
            expectedTotal += amount;
        }

        const preview = buildBatchClaimPreview(proofs, metadata);
        expect(BigInt(preview.totalClaimable)).toBe(expectedTotal);
    });
});

// ── 7. Oversized amounts and edge timestamps ──────────────────────────────────

describe('oversized amount and timestamp safe degradation', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-06-01T00:00:00Z'));
    });

    it('handles maximum safe BigInt amounts without overflow', () => {
        const MAX_I128 = (BigInt(2) ** BigInt(127) - BigInt(1)).toString();
        const proofs = { vault1: makeProof(0, { amount: MAX_I128 }) };
        const metadata = { vault1: { name: 'Max Vault' } };

        const preview = buildBatchClaimPreview(proofs, metadata);
        expect(preview.vaults[0].claimableAmount).toBe(MAX_I128);
        expect(BigInt(preview.totalClaimable)).toBe(BigInt(MAX_I128));
    });

    it('calculateTotalClaimable handles a large number of vaults with big amounts', () => {
        const vaults = Array.from({ length: 200 }, (_, i) => makeVault(i + 1));
        const total = calculateTotalClaimable(vaults);
        // Sum 1..200 * 1_000_000
        const expected = BigInt(200 * 201 / 2) * BigInt(1_000_000);
        expect(total).toBe(expected);
    });

    it('getClaimableVaults filters correctly from a mixed large vault list', () => {
        const claimable = makeVaults(30, 'claimable');
        const stale = makeVaults(20, 'stale_proof').map(v => ({ ...v, vaultId: `stale-${v.vaultId}` }));
        const unavailable = makeVaults(10, 'unavailable').map(v => ({ ...v, vaultId: `unavail-${v.vaultId}` }));
        const all = [...claimable, ...stale, ...unavailable];

        expect(getClaimableVaults(all)).toHaveLength(30);
    });

    it('a vault with a zero-amount proof does not inflate totalClaimable', () => {
        const proofs = {
            vault1: makeProof(0, { amount: '0' }),
            vault2: makeProof(1, { amount: '5000000000' }),
        };
        const metadata = {
            vault1: { name: 'Zero Vault' },
            vault2: { name: 'Real Vault' },
        };

        const preview = buildBatchClaimPreview(proofs, metadata);
        expect(preview.totalClaimable).toBe('5000000000');
    });
});
