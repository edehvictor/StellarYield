# Portfolio Valuation — Duplicate Submission Protection

> Issue: [#1864](https://github.com/edehvictor/StellarYield/issues/1864)

## Overview

Portfolio valuation operations now carry an **immutable operation identity** that prevents duplicate submissions from applying the same effect twice, while preserving existing state and balances when validation or execution fails.

## Operation Identity

Every valuation request is assigned a `ValuationOperationIdentity`:

| Field               | Description                                                      |
|---------------------|------------------------------------------------------------------|
| `operationId`       | Unique key (UUID, idempotency key, or auto-generated hash).      |
| `payloadFingerprint`| Deterministic SHA-256 hash over the canonicalized payload.       |
| `shortId`           | Human-readable short form, e.g. `vop-a1b2c3…d4e5`.              |
| `createdAt`         | ISO 8601 timestamp of identity creation.                         |

### Payload Fingerprinting

Payloads are canonicalized before hashing:

1. Positions are sorted by `protocol` then `asset`.
2. Numeric fields are rounded to 4 decimal places.
3. Wallet addresses and currency codes are uppercased.
4. The result is deterministically stringified and SHA-256 hashed.

This ensures that identical payloads always produce the same fingerprint, regardless of field ordering or minor floating-point differences.

## Duplicate Handling

| Scenario                           | Response                              | State Change |
|--------------------------------------|---------------------------------------|-------------|
| New operation                        | `201 Created`, effects committed      | Updated     |
| Replay (same ID + same fingerprint)  | `200 OK`, replayed result returned    | None        |
| Concurrent duplicate (in-flight)     | `409 DUPLICATE_VALUATION_IN_PROGRESS` | None        |
| Identity conflict (same ID, diff payload) | `409 OPERATION_IDENTITY_CONFLICT` | None        |
| Validation failure                   | `422 VALIDATION_FAILED`               | None        |
| Execution failure                    | `500 EXECUTION_FAILED`                | None        |

## State Preservation Guarantees

- **Validation failure**: State and balances remain exactly as supplied. No operation record is committed.
- **Execution failure**: State and balances remain exactly as supplied. The operation is marked `failed`, enabling safe retry with a new `operationId`.
- **Duplicate replay**: The originally committed summary and effects are returned. No second state mutation occurs.

## Safe Retry Flow

```
Client                    Server
  │                         │
  ├─ POST valuation ──────► │  operationId: "op-1"
  │                         │  → execute() throws
  │  ◄── 500 EXEC_FAILED ──┤  state preserved
  │                         │
  ├─ POST valuation ──────► │  operationId: "op-2" (new ID)
  │                         │  → execute() succeeds
  │  ◄── 201 Created ──────┤  state updated, effects committed
  │                         │
  ├─ POST valuation ──────► │  operationId: "op-2" (replay)
  │                         │  → fingerprint matches committed record
  │  ◄── 200 Replayed ─────┤  no second state mutation
```

## Client Error Codes (#1864)

New error codes added to `PortfolioValuationErrorCode`:

| Code                             | Message                                                                               |
|----------------------------------|---------------------------------------------------------------------------------------|
| `DUPLICATE_VALUATION_SUBMISSION` | This valuation request was already submitted. Showing previous result.                |
| `VALUATION_IN_PROGRESS`          | A valuation is already in progress. Please wait before retrying.                      |
| `VALUATION_IDENTITY_CONFLICT`    | Operation identity conflict: the submitted parameters do not match the original submission. |

## API

### Types

- `PortfolioValuationPayload` — submitted valuation input
- `ValuationOperationIdentity` — immutable operation identity
- `ValuationEffect` — committed atomic effect record
- `ValuationOperationRecord` — full operation log entry
- `SafeValuationOptions<TState, TResult>` — execution options
- `SafeValuationResult<TState, TResult>` — execution result

### Functions

- `canonicalizeValuationPayload(payload)` — deterministic canonicalization
- `computeValuationPayloadFingerprint(payload)` — SHA-256 fingerprint
- `createValuationOperationIdentity(payload, customId?)` — create identity

### Classes

- `ValuationOperationManager` — in-memory duplicate protection manager
  - `executeValuation(options)` — safely execute or replay a valuation
  - `getOperation(operationId)` — query operation status
  - `clear()` — reset all tracked operations

### Singleton

- `defaultValuationOperationManager` — shared global instance

## Files Modified

| File | Change |
|------|--------|
| `shared/types/portfolioValuation.ts` | Added operation identity types, fingerprinting, and `ValuationOperationManager` |
| `shared/types/portfolioValuation.operationIdentity.test.ts` | Regression tests (20 tests) |
| `client/src/portfolio/portfolioValuationErrors.ts` | Added 3 new error codes and classifier rules |
| `client/src/portfolio/portfolioValuationErrors.test.ts` | Added 3 new error classification tests |
| `docs/portfolio-valuation-duplicate-protection.md` | This documentation |
