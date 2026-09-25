import type {
    ClaimPreviewResult,
    CurrentCampaignInfo,
} from './types';

/** A single 32-byte proof element must be exactly 64 hex characters. */
const PROOF_ELEMENT_PATTERN = /^[0-9a-fA-F]{64}$/;
const ROOT_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Mirrors backend/rewards MAX_PROOF_DEPTH — trees up to 2^20 recipients. */
const MAX_PROOF_DEPTH = 20;

/**
 * Structural validation of a proof array: every element must be a 32-byte
 * hex string, the depth must respect MAX_PROOF_DEPTH, and no sibling hash
 * may repeat (a well-formed Merkle proof never revisits the same node twice
 * — a repeated element is a sign of a truncated, replayed, or tampered proof).
 */
export function findProofShapeError(proof: string[]): string | null {
    if (!Array.isArray(proof)) {
        return 'Proof must be an array of hex-encoded sibling hashes';
    }

    if (proof.length > MAX_PROOF_DEPTH) {
        return `Proof depth ${proof.length} exceeds maximum allowed depth of ${MAX_PROOF_DEPTH}`;
    }

    const seen = new Set<string>();
    for (const element of proof) {
        if (typeof element !== 'string' || !PROOF_ELEMENT_PATTERN.test(element)) {
            return `Proof contains a malformed path element: "${String(element)}"`;
        }
        const normalized = element.toLowerCase();
        if (seen.has(normalized)) {
            return `Proof contains a duplicate path element: "${element}"`;
        }
        seen.add(normalized);
    }

    return null;
}

export interface ClaimPreviewCandidate {
    /** Campaign the cached proof was generated for, if known. */
    campaignId?: string;
    /** Merkle root the cached proof was generated against, if known. */
    merkleRoot?: string;
    proof: string[];
}

/**
 * Client-side pre-flight check for a cached claim proof: campaign ID match,
 * proof shape, and root drift relative to the currently active campaign.
 *
 * This intentionally does not repeat the cryptographic Merkle verification
 * the backend already performed when it issued the proof — its job is to
 * catch cases where *locally cached* proof data has gone stale or was
 * corrupted before the user attempts to submit a claim transaction.
 */
export function getClaimPreviewState(
    candidate: ClaimPreviewCandidate,
    current: CurrentCampaignInfo,
): ClaimPreviewResult {
    if (candidate.campaignId !== undefined && candidate.campaignId !== current.campaignId) {
        return {
            state: 'invalid',
            errorCode: 'campaign_id_mismatch',
            message: `This proof targets campaign "${candidate.campaignId}", but the active campaign is "${current.campaignId}".`,
        };
    }

    const shapeError = findProofShapeError(candidate.proof);
    if (shapeError) {
        return {
            state: 'invalid',
            errorCode: 'malformed_proof',
            message: shapeError,
        };
    }

    if (candidate.merkleRoot !== undefined) {
        if (!ROOT_PATTERN.test(candidate.merkleRoot)) {
            return {
                state: 'invalid',
                errorCode: 'malformed_proof',
                message: `Merkle root "${candidate.merkleRoot}" is not a valid 32-byte hex value.`,
            };
        }

        if (candidate.merkleRoot.toLowerCase() !== current.merkleRoot.toLowerCase()) {
            return {
                state: 'stale',
                errorCode: 'root_mismatch',
                message:
                    'This proof was generated against an earlier version of the reward tree. Refresh to get an updated proof.',
            };
        }
    }

    return {
        state: 'valid',
        message: 'Claim proof looks valid.',
    };
}
