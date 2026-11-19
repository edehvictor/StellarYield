# Transaction review: boundary-value arithmetic (#1890)

Quote and review amounts are handled with exact integer (BigInt) math. Floating point is never used for token amounts.

## Rules

| Concern | Behavior |
|---|---|
| Amount format | `amountInStroops` must match `^\d+$`. Signs, decimals, exponents and whitespace are rejected (`INVALID_AMOUNT`, HTTP 400). |
| Range | `1 … 2^127 - 1` (Soroban i128). Zero and values above the maximum are rejected before any arithmetic. |
| Slippage input | Clamped to `[0.001, 0.15]`. Non-finite values are rejected by `POST /api/zap/quote` (`INVALID_SLIPPAGE`); inside `getZapQuote` they fall back to the model slippage. |
| Slippage rounding | Applied slippage is rounded to the nearest 1e-6 before use, so float noise (`1 - 0.07`) cannot shift results by a unit. |
| Minimum output | `floor(expectedOut * (1 - slippage))`, rounded **down**, never above the expected output. |
| Overflow | Results are re-checked against i128 max; `mulDivFloor` returns `null` on a zero denominator. |
| Failure/retry | Quote generation is pure: a rejected request changes no state, and repeating a valid request returns the same minimum. |

Server helpers: `server/src/services/stroopsMath.ts`. Client mirror: `client/src/components/transaction/reviewAmounts.ts`.

## Stale configuration snapshots (transaction review)

Zap quote/review work is bound to an immutable configuration snapshot fingerprint
(`assetConfigVersion`, SHA-256 of the supported asset configuration) and, when
present, a cryptographic assumption fingerprint over the quoted review
assumptions.

- `POST /api/zap/verify` (and pre-submit verification) rejects missing/mismatched
  `assetConfigVersion` as `CONFIG_DRIFT`, and rejects stale/untrusted assumption
  snapshots as `ASSUMPTION_DRIFT` or `INVALID_FINGERPRINT`.
- These failures are treated as stale/untrusted review snapshots: verification is
  read-only, no balances or signed transactions are mutated, and the quote must
  be refreshed/re-reviewed before submission (safe retry).
- Clients must invalidate and not reuse a rejected quote; refreshing the quote
  binds subsequent review/execution work to the current immutable snapshot.

## Client review modal

`TransactionReviewModal` disables **Confirm & Sign** and shows a "Submission blocked" alert when:

- the deposit amount or estimated output is zero, malformed, has more fractional digits than the token's decimals, or exceeds i128;
- the guaranteed minimum exceeds the estimated output;
- slippage is not a finite number in `[0, 100]`.

A zero guaranteed minimum is allowed (very small deposits). A caller-supplied `error` prop takes precedence over these checks.

## Tests

- `server/src/__tests__/zapQuoteBoundary.test.ts`
- `server/src/__tests__/zapQuoteConfigFingerprint.test.ts`
- `client/src/components/transaction/reviewAmounts.test.ts`
- `client/src/components/transaction/TransactionReviewModal.test.tsx`
