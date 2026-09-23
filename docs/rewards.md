# Rewards: Deterministic Claim Batch Ordering

## Overview

Batched Merkle claim submissions (proofs + previews) must be ordered
reproducibly: identical input sets must always produce identical ordered
batches, regardless of the order in which the caller supplied them. This
document is the canonical contract for that ordering and for how
duplicates are handled.

Implementation: `backend/rewards/src/claimBatchOrdering.ts` (canonical),
mirrored for the server in `server/src/services/rewards/claimBatchOrdering.ts`.
Tests: `backend/rewards/src/__tests__/claimBatchOrdering.test.ts` and
`server/src/services/rewards/__tests__/claimBatchOrdering.test.ts`.

## The contract

1. **Canonical sort order.** A batch is ordered by `campaignId`, then
   `account`, then `asset` (each lexicographic, UTF-16 code-unit order),
   then `claimIndex` **numerically** — index `10` sorts after index `2`,
   never between `1` and `3`.
2. **Stable across input order.** `normalizeClaimBatch` returns a new,
   sorted array and never mutates the caller's input. Two calls with the
   same set of claims produce byte-identical batches no matter how the
   input was shuffled.
3. **Duplicates are rejected, not merged.** Two claims sharing the same
   `(campaignId, account, asset, claimIndex)` key are a duplicate —
   regardless of whether `amount`/`proof` differ — and the batch is
   rejected with a typed `DuplicateClaimError` (`code: "duplicate_claim"`)
   that carries the colliding `duplicateKey` and the offending claim.
   Rejection happens **before** ordering, so a bad batch fails fast.
4. **A claim is identified by its position key, not its payload.** The
   canonical key is
   `campaignId \u0000 account \u0000 asset \u0000 claimIndex`
   (see `claimOrderKey`). Claims differing in any of the four dimensions
   are distinct entries.

## API summary

| Function | Purpose |
|---|---|
| `normalizeClaimBatch(claims)` | Return a new, deterministically ordered, duplicate-free batch. Throws `DuplicateClaimError` on the first duplicate. |
| `compareClaims(a, b)` | Total-order comparator over `(campaignId, account, asset, claimIndex)`. Returns `0` only for duplicate keys. |
| `claimOrderKey(claim)` | Canonical uniqueness/order key string for a claim. |
| `DuplicateClaimError` | Typed error with `code`, `duplicateKey`, and the offending `claim`. |

## The `BatchClaim` shape

| Field | Meaning |
|---|---|
| `campaignId` | Stable campaign identifier (e.g. `"2026-W22"`). |
| `account` | Stellar wallet address of the claimant. |
| `asset` | Asset symbol/code being claimed (e.g. `"YIELD"`). |
| `claimIndex` | Leaf index in the campaign's Merkle tree. |
| `amount` | Claim amount in stroops. |
| `proof` | Merkle proof path (hex sibling hashes). |

## Why this matters

- **Reproducible previews.** Preview endpoints and client dry-runs show the
  same claim order for the same input set, so screenshots, diffs, and
  regression tests are stable.
- **Deterministic submission.** A keeper or relayer submitting a batch
  on-chain submits in the same order every time, which keeps gas
  estimates, failure isolation, and audit logs reproducible.
- **No silent double claims.** Rejecting duplicate keys with a typed error
  (instead of deduping silently) makes the ambiguity explicit to callers,
  so an accidentally repeated claim is surfaced rather than dropped.

## Keeping the two implementations in sync

`backend/rewards/src/claimBatchOrdering.ts` is canonical. The server copy
in `server/src/services/rewards/claimBatchOrdering.ts` exists because the
server package does not depend on `@stellaryield/rewards`. When changing
the contract, update **both** files and **both** test suites; the
acceptance criteria (identical sets → identical ordered batches, shuffled
inputs stable, duplicates rejected with the typed error) must hold in both.
