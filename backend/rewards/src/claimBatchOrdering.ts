/**
 * Deterministic ordering for batched Merkle claim submissions (#1031).
 *
 * Batched claim submissions (proofs + previews) must be ordered
 * reproducibly: identical input sets must always produce identical
 * ordered batches, regardless of the order in which the caller supplied
 * them. This module normalizes a batch into a stable, duplicate-free
 * order keyed by (campaign, account, asset, claim index).
 *
 * Contract:
 * - Ordering is canonical: sort by `campaignId`, then `account`, then
 *   `asset`, then `claimIndex` (numeric).
 * - Duplicates — two claims sharing the same
 *   (campaignId, account, asset, claimIndex) key — are rejected with a
 *   typed `DuplicateClaimError` instead of being silently merged or
 *   double-submitted.
 * - The input array is never mutated; a new array is returned.
 */

/** A single claim in a batched Merkle proof submission. */
export interface BatchClaim {
  /** Stable campaign identifier (e.g. "2026-W22"). */
  campaignId: string;
  /** Stellar wallet address of the claimant. */
  account: string;
  /** Asset symbol/code being claimed (e.g. "YIELD"). */
  asset: string;
  /** Leaf index in the campaign's Merkle tree. */
  claimIndex: number;
  /** Claim amount in stroops. */
  amount: string;
  /** Merkle proof path (hex sibling hashes). */
  proof: string[];
}

/** Error code carried by {@link DuplicateClaimError}. */
export type DuplicateClaimErrorCode = "duplicate_claim";

/**
 * Typed error raised when a batch contains two claims with the same
 * (campaignId, account, asset, claimIndex) key.
 */
export class DuplicateClaimError extends Error {
  constructor(
    public readonly code: DuplicateClaimErrorCode,
    /** The canonical order key that collided. */
    public readonly duplicateKey: string,
    /** The later claim that collided with an earlier one. */
    public readonly claim: BatchClaim,
  ) {
    super(
      `Duplicate claim in batch: ${duplicateKey} appears more than once. ` +
        `Batches must contain exactly one claim per (campaign, account, asset, claim index).`,
    );
    this.name = "DuplicateClaimError";
  }
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Canonical uniqueness/order key for a claim:
 * `campaignId \u0000 account \u0000 asset \u0000 claimIndex`.
 * Two claims are considered duplicates iff they share this key.
 */
export function claimOrderKey(claim: BatchClaim): string {
  return [claim.campaignId, claim.account, claim.asset, String(claim.claimIndex)].join("\u0000");
}

/**
 * Total-order comparator over claims: campaignId, then account, then
 * asset (all lexicographic), then claimIndex (numeric). Returns 0 only
 * for claims that share an order key (i.e. duplicates).
 */
export function compareClaims(a: BatchClaim, b: BatchClaim): number {
  const byCampaign = compareStrings(a.campaignId, b.campaignId);
  if (byCampaign !== 0) return byCampaign;
  const byAccount = compareStrings(a.account, b.account);
  if (byAccount !== 0) return byAccount;
  const byAsset = compareStrings(a.asset, b.asset);
  if (byAsset !== 0) return byAsset;
  return a.claimIndex - b.claimIndex;
}

/**
 * Normalize a batch of claims into deterministic, duplicate-free order.
 *
 * - Rejects duplicates with a typed {@link DuplicateClaimError} before
 *   any ordering happens, so a bad batch fails fast.
 * - Returns a new array sorted by (campaign, account, asset, claim
 *   index); the caller's array is left untouched.
 * - Deterministic: identical sets of claims yield identical ordered
 *   batches no matter what order the input was in.
 *
 * @param claims - The batch to normalize.
 * @throws DuplicateClaimError if any two claims share an order key.
 */
export function normalizeClaimBatch(claims: BatchClaim[]): BatchClaim[] {
  const seen = new Set<string>();

  for (const claim of claims) {
    const key = claimOrderKey(claim);
    if (seen.has(key)) {
      throw new DuplicateClaimError("duplicate_claim", key, claim);
    }
    seen.add(key);
  }

  return [...claims].sort(compareClaims);
}
