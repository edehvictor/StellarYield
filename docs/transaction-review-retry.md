# Transaction review: partial completion and retry (#1891)

A reviewed zap deposit runs in stages: review, wallet signature, submission,
confirmation. It can be interrupted between any two of them, for example by a
closed tab, a dropped connection after the wallet signs, or confirmation
polling that times out while the transaction still lands. Before this change,
a timed-out deposit was shown as "Transaction failed", and retrying sent a
second deposit while the first could still be confirmed.

The rule now: **a second deposit is never submitted while a signed one could
still move funds, and a retry is allowed as soon as nothing can.**

## Stages

```
reviewed ──signed(hash)──▶ signed ──submitted(hash)──▶ submitted ──confirmed──▶ confirmed
   │                         │                            │
   └──────── failed ─────────┴────────── failed ──────────┘
```

The state machine is `shared/types/transactionReviewOperation.ts`, shared by
the client and the server.

- The transaction hash is computed from the signed envelope and recorded
  **before** the transaction is sent (`ZapSubmissionHooks.onSigned`). An
  interrupted submission can always be looked up on the ledger.
- Replaying an event is a no-op. Reporting a different hash or moving
  backwards is refused.
- A confirmation is accepted even after a reported failure, because a timed-out
  poll can still land.

## Persisted state

The local deposit draft (`deposit_draft_<wallet>` in `localStorage`, from
#1146) now also stores `operationId`, `deadlineUnixSeconds` (the contract
deadline passed to `zap_deposit_with_deadline`) and `ledgerConfirmed`. It is
saved without a hash before signing, re-saved with the hash as soon as the
wallet signs, and marked `ledgerConfirmed` once the ledger confirms.

The server journal records the same operation so another tab or device can see
an in-flight deposit (see API below). Journal calls are best effort: if the
server cannot be reached, the local guard still applies and the deposit
proceeds.

## Retry decision

`planReviewRetry(operation, ledgerStatus, now)` is called before a new
submission when the draft holds a hash. The ledger status comes from
`getLedgerTransactionStatus(hash)` (Soroban RPC `getTransaction`).

| Earlier attempt | Ledger | Decision |
| --- | --- | --- |
| Never signed | — | Resubmit: nothing can have moved |
| Signed, `ledgerConfirmed` | (not asked) | Done: a new deposit is allowed |
| Signed | `success` | Done: a new deposit is allowed |
| Signed | `failed` | Resubmit: a failed transaction applies no effects |
| Signed, deadline passed | `not_found` | Resubmit with a fresh quote: it can no longer move funds |
| Signed | `not_found` before the deadline, or `unknown` | **Wait**: not submitted again |

`unknown` (RPC unreachable) never counts as "not found". A draft from before
this change has no deadline and waits until the ledger answers.

## Classifying a submission

`classifyZapSubmission(result, signedHash)`:

| Result | Outcome | Draft |
| --- | --- | --- |
| Success | confirmed | kept with `ledgerConfirmed` for indexer reconciliation |
| Failed before signing | failed (`NOT_SIGNED`) | cleared |
| Node rejected the send (`rejected`) | failed (`SUBMISSION_REJECTED`) | cleared |
| Ledger recorded failure | failed (`TX_FAILED_ONCHAIN`) | cleared |
| Poll timed out (`pending`) | in flight (`CONFIRMATION_TIMEOUT`) | kept |
| Send threw after signing | in flight (`SUBMISSION_OUTCOME_UNKNOWN`) | kept |

An in-flight deposit shows the "Deposit still processing" banner and the message
"Your deposit was sent but is not confirmed yet. It will not be submitted
again". It does not show the failed-transaction modal.

`TxResult` gained `pending` (poll timed out) and `rejected` (node refused at
submission) so this no longer depends on parsing error text.

## API

All under `/api/zap`; documented in `server/openapi.yaml`.

| Method and path | Purpose |
| --- | --- |
| `POST /review-operations` | Start (201) or resume (200) an operation. Body: `operationId`, `walletAddress`, `routeHash`, `amountInStroops`, `minAmountOutStroops`, `deadlineUnixSeconds` |
| `POST /review-operations/:operationId/events` | Record `signed`, `submitted`, `confirmed` (with `txHash`) or `failed` (with `code`) |
| `GET /review-operations/:operationId?walletAddress=` | Read the operation |

Errors:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REVIEW_OPERATION` | Malformed id, request or event |
| 404 | `REVIEW_OPERATION_NOT_FOUND` | Unknown id for this wallet |
| 409 | `REVIEW_OPERATION_IN_FLIGHT` | Another deposit from the wallet is signed, unsettled and before its deadline. `recoverable: true`; `details.operation` names it |
| 409 | `REVIEW_OPERATION_MISMATCH` | The id was already used for a different deposit |
| 409 | `REVIEW_OPERATION_INVALID_TRANSITION` | The event cannot follow the current stage |
| 409 | `REVIEW_OPERATION_TX_HASH_MISMATCH` | The operation is bound to another transaction |

A rejected event leaves the stored operation unchanged. Operations are scoped
to the wallet, and the journal never moves funds.

## Tests

- `shared/types/transactionReviewOperation.test.ts`
- `server/src/__tests__/transactionReviewOperations.test.ts`
- `client/src/features/zap/reviewOperation.test.ts`
- `client/src/features/zap/ZapDepositPanel.reviewRetry.test.tsx`
