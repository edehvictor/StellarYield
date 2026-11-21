# Transaction review: duplicate-submission protection (#1888)

A transaction review can be submitted more than once: a confirm button is
double-clicked, a wallet prompt is dismissed and reopened, or a network poll
times out after the transaction was already accepted. The protection added for
#1888 makes those retries safe: the same logical review always carries the same
operation identity, and applying its effect twice is impossible.

## Operation identity

The shared contract lives in
[`shared/types/transactionReviewOperation.ts`](../shared/types/transactionReviewOperation.ts).

| Field | Meaning |
| --- | --- |
| `operationId` | Stable UUID-like id for one logical review (`txrev_…`). |
| `payloadFingerprint` | SHA-256 over the canonical reviewed payload (wallet, contracts, amounts, `allowPartial`, deadline, route hash). |
| `contractOpId` | Decimal `u64` derived from `operationId`; passed to the zap contract as `op_id`. |
| `shortId` / `createdAt` | Display and audit metadata. |

`createTransactionReviewOperationIdentity()` creates a fresh identity; passing
the stored `operationId` restores it. `resolveReviewOperation()` on the client
restores a draft identity **only** when its fingerprint still matches the
payload being reviewed, so edited inputs can never reuse an old `op_id`.

`TransactionReviewOperationManager.executeTransactionReview()` is the
state-transition guard:

| Situation | Result |
| --- | --- |
| Normal submission | Effect runs once; state updates once; record becomes `committed`. |
| Same identity replayed | Recorded effect is returned with `replayed: true`; caller state is returned unchanged; effect does **not** run again. |
| Same identity, different payload | `REVIEW_OPERATION_IDENTITY_CONFLICT`; no effect, no state change. |
| Concurrent duplicate | `DUPLICATE_REVIEW_IN_PROGRESS`; no effect, no state change. |
| Validation failure | `REVIEW_VALIDATION_FAILED`; original state/balances preserved; effect never runs. |
| Execution failure | `REVIEW_EXECUTION_FAILED`; original state/balances preserved; safe to retry with the same identity. |

## Client flow (`ZapDepositPanel`)

1. Build the review payload from the quoted amounts, contracts, deadline and
   route hash, then resolve the operation identity from the persisted deposit
   draft (or create a new one).
2. Send `X-Operation-Identity` with `POST /api/zap/verify` so a failed review
   can be correlated with the logical deposit.
3. Pass `opId: BigInt(contractOpId)` to `zapDeposit()`, which forwards it as the
   zap contract's `op_id` argument before `deadline`.
4. Persist the identity in the deposit draft until the deposit succeeds. A
   reload or retry therefore reuses the same `op_id`.
5. `OpAlreadySettled` (code 7) means the effect already completed: the UI shows
   a deterministic message and clears the settled identity instead of starting
   a second deposit.

On-chain state is preserved by the zap contract itself: a `Settled` operation
is rejected before any token moves, and a `Pending` operation is resumed
without pulling the user's input again. See
[`contracts/zap/README.md`](../contracts/zap/README.md) for status semantics.

## Server flow (`/api/zap/*`)

The review endpoints remain read-only. The new middleware in
[`server/src/middleware/reviewOperation.ts`](../server/src/middleware/reviewOperation.ts):

- accepts an optional `X-Operation-Identity` (8–128 chars of `A-Za-z0-9_-`);
- rejects a malformed value with `INVALID_OPERATION_IDENTITY` (400) and a
  privacy-safe `VALIDATION_FAILED` diagnostic before any review stage runs;
- echoes a valid value in the response header and in `operationId` on error
  bodies, alongside `requestId` and stage diagnostics.

Omitting the header remains valid for older clients.

## Tests

- `shared/types/transactionReviewOperation.test.ts` — identity, normal run,
  validation/execution failure, duplicate replay, conflict, safe retry.
- `client/src/features/zap/reviewOperation.test.ts` — draft restore, changed
  payload, malformed identity.
- `client/src/features/zap/fetchSwapQuote.test.ts` — header propagation and
  error-body parsing.
- `server/src/__tests__/zapReviewOperation.test.ts` — header validation,
  echo and error correlation.
