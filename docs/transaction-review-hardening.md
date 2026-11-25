# Transaction Review Hardening Against Malformed External Data (#1889)

## Overview

Transaction review is the critical security boundary where users inspect and verify execution parameters before cryptographically signing and submitting transactions to the Stellar network.

To protect against malformed, corrupted, or tampered external data originating from untrusted APIs, URL query parameters, or stale state, boundary validation is enforced across both client and server layers.

## Client Boundary Validation

The client review boundary is managed by `validateTransactionReview` ([`shared/types/transactionReview.ts`](../shared/types/transactionReview.ts)) and implemented in [`TransactionReviewModal`](../client/src/components/transaction/TransactionReviewModal.tsx).

### Validation Guarantees

1. **Untrusted Fields Validated at Boundary**:
   - `walletAddress`: Must be a valid Stellar public key (`G...`) or contract address (`C...`) of valid length and format.
   - `inputToken.amount`: Must be a positive decimal or integer numeric string (`> 0`). Non-numeric values, empty strings, negative amounts, and `NaN` are rejected.
   - `inputToken.symbol`: Must be a valid 1-12 character alphanumeric symbol.
   - `vaultToken.amount`: Must be a positive numeric string (`> 0`).
   - `vaultToken.minAmount`: If supplied, must be a positive numeric value and cannot exceed `vaultToken.amount` (the minimum guaranteed output cannot exceed estimated output).
   - `slippageTolerance`: Must be a finite number between `0%` and `50%`.
   - `assumptions`: Must be a well-formed object with parseable timestamps and positive stroop amounts. Quotes whose `expiresAt` is in the past are rejected with `ASSUMPTIONS_EXPIRED`.
   - `fingerprint`: If provided, must match 64-character SHA-256 hexadecimal format. If assumptions are present, the fingerprint is cryptographically verified; drift triggers `ASSUMPTION_DRIFT`.

2. **Typed Failures**:
   Boundary failures return typed, machine-readable failure objects (`TransactionReviewValidationError`) containing:
   - `code`: Explicit error code (e.g. `INVALID_WALLET_ADDRESS`, `INVALID_INPUT_AMOUNT`, `MIN_AMOUNT_EXCEEDS_OUTPUT`, `INVALID_SLIPPAGE`, `ASSUMPTIONS_EXPIRED`, `ASSUMPTION_DRIFT`).
   - `field`: The exact parameter that failed validation.
   - `message`: User- and reviewer-friendly explanation.

3. **State & Balance Preservation**:
   When validation fails:
   - The "Confirm & Sign" button is strictly disabled (`canConfirm = false`).
   - The validation error is surfaced directly in an alert panel with role `alert` and data-testid `transaction-review-validation-error`.
   - The `onConfirm` callback is guarded and will never execute.
   - No balances are debited, no transactions are submitted, and existing drafts remain untouched.

4. **Safe Retry Behavior**:
   The validation boundary is pure and idempotent. When invalid parameters are corrected (e.g., refreshing a stale quote or entering valid amounts), the boundary re-evaluates cleanly, errors clear, and confirmation is safely re-enabled without residual state.

---

## Server Boundary Validation

The server enforces boundary validation on quote generation and quote verification endpoints ([`server/src/routes/zap.ts`](../server/src/routes/zap.ts) and [`server/src/middleware/validation.ts`](../server/src/middleware/validation.ts)):

1. `POST /api/zap/quote`:
   - `amountInStroops`: Must be a strictly positive integer string (`/^\d+$/` and `BigInt(amountInStroops) > 0n`). Negative amounts and zero return typed `INVALID_AMOUNT` (400).
   - `inputTokenContract` / `vaultTokenContract`: Must be non-empty strings; invalid strings return `INVALID_CONTRACT` (400).
   - `slippageTolerance`: If provided, must be a finite number between 0 and 50; invalid values return `INVALID_SLIPPAGE` (400).
   - `inputDecimals` / `vaultDecimals`: If provided, must be integers between 0 and 18; invalid values return `INVALID_DECIMALS` (400).
   - `walletAddress`: If provided, must be a valid Stellar public key or contract address; invalid values return `INVALID_ADDRESS` (400).

2. `POST /api/zap/verify`:
   - Validates that `path` is an array of valid hop objects with non-empty `contractId` strings before attempting cryptographic hashing.
   - Validates that `assumptionFingerprint` is a 64-character hex string; malformed digests return `INVALID_QUOTE` (400).
   - Validates that `slippageApplied` is non-negative and finite.

3. `POST /api/zap/fingerprint`:
   - Validates that the assumptions payload contains required fields (`amountInStroops`, `inputTokenContract`, `vaultTokenContract`) before fingerprinting; malformed payloads return `INVALID_ASSUMPTIONS` (400) without throwing unhandled exceptions.
