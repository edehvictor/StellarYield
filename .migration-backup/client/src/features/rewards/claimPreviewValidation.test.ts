import { describe, it, expect } from 'vitest';
import { findProofShapeError, getClaimPreviewState } from './claimPreviewValidation';
import type { CurrentCampaignInfo } from './types';

describe('findProofShapeError', () => {
    const validHash = 'a'.repeat(64);
    const otherValidHash = 'b'.repeat(64);

    it('returns null for a well-formed proof', () => {
        expect(findProofShapeError([validHash, otherValidHash])).toBeNull();
    });

    it('returns null for an empty proof', () => {
        expect(findProofShapeError([])).toBeNull();
    });

    it('flags a malformed (non-hex) element', () => {
        expect(findProofShapeError(['not-valid-hex'])).toMatch(/malformed/i);
    });

    it('flags an element with the wrong length', () => {
        expect(findProofShapeError(['ab'.repeat(10)])).toMatch(/malformed/i);
    });

    it('flags a duplicate path element', () => {
        expect(findProofShapeError([validHash, otherValidHash, validHash])).toMatch(/duplicate/i);
    });

    it('flags a proof deeper than the maximum allowed depth', () => {
        const deepProof = Array.from({ length: 21 }, (_, i) => i.toString(16).padStart(64, '0'));
        expect(findProofShapeError(deepProof)).toMatch(/exceeds/i);
    });
});

describe('getClaimPreviewState', () => {
    const current: CurrentCampaignInfo = {
        campaignId: '2026-W22',
        merkleRoot: 'a'.repeat(64),
    };
    const proof = ['b'.repeat(64)];

    it('returns valid when campaign, root, and shape all match', () => {
        const result = getClaimPreviewState(
            { campaignId: '2026-W22', merkleRoot: 'a'.repeat(64), proof },
            current,
        );
        expect(result.state).toBe('valid');
        expect(result.errorCode).toBeUndefined();
    });

    it('treats missing campaignId/merkleRoot as an optimistic pass-through (no crash)', () => {
        const result = getClaimPreviewState({ proof }, current);
        expect(result.state).toBe('valid');
    });

    it('flags a campaign ID mismatch as invalid', () => {
        const result = getClaimPreviewState(
            { campaignId: '2026-W21', merkleRoot: 'a'.repeat(64), proof },
            current,
        );
        expect(result.state).toBe('invalid');
        expect(result.errorCode).toBe('campaign_id_mismatch');
    });

    it('flags a malformed proof as invalid', () => {
        const result = getClaimPreviewState(
            { campaignId: '2026-W22', merkleRoot: 'a'.repeat(64), proof: ['bad-hash'] },
            current,
        );
        expect(result.state).toBe('invalid');
        expect(result.errorCode).toBe('malformed_proof');
    });

    it('flags a duplicate proof path as invalid', () => {
        const result = getClaimPreviewState(
            { campaignId: '2026-W22', merkleRoot: 'a'.repeat(64), proof: [proof[0], proof[0]] },
            current,
        );
        expect(result.state).toBe('invalid');
        expect(result.errorCode).toBe('malformed_proof');
    });

    it('flags a drifted root as stale, not invalid', () => {
        const result = getClaimPreviewState(
            { campaignId: '2026-W22', merkleRoot: 'c'.repeat(64), proof },
            current,
        );
        expect(result.state).toBe('stale');
        expect(result.errorCode).toBe('root_mismatch');
    });

    it('is case-insensitive when comparing roots', () => {
        const result = getClaimPreviewState(
            { campaignId: '2026-W22', merkleRoot: 'A'.repeat(64), proof },
            current,
        );
        expect(result.state).toBe('valid');
    });
});
