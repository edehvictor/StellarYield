# SDK Signer Adapter — Duplicate Submission Protection & Idempotency

> Issue: [#1861](https://github.com/edehvictor/StellarYield/issues/1861)

## Overview

The SDK signer adapter layer (`packages/sdk/src/signers.ts`) includes built-in duplicate submission detection, immutable operation identities, and atomic state preservation. This ensures that repeating or retrying a transaction signing request cannot duplicate effects, prompt user wallets multiple times, or corrupt local account state.

## Core Concepts

### 1. Immutable Operation Identity

Every signer submission is associated with a `SignerOperationIdentity`:

| Field | Type | Description |
|---|---|---|
| `operationId` | `string` | Unique key passed by caller (e.g. idempotency key/UUID) or deterministically generated. |
| `payloadFingerprint` | `string` | Deterministic SHA-256 hash across `unsignedXdr`, `networkPassphrase`, and `contractId`. |
| `shortId` | `string` | Human-readable identifier format (e.g., `sop-a1b2c3…d4e5`). |
| `publicKey` | `string?` | Signer public key associated with the operation. |
| `txHash` | `string?` | Stellar transaction hash parsed from valid XDR. |
| `createdAt` | `string` | ISO 8601 creation timestamp. |

The operation identity is frozen and immutable upon creation.

### 2. Operation Lifecycle & Statuses

An operation progresses through well-defined lifecycle states:

```
[New Request]
      │
      ├── (Validation Fails) ──────► REJECTED (State & Balances Preserved)
      │
      ├── (Validation Passes) ────► IN_FLIGHT
                                       │
                                       ├── (Signing / Exec Succeeded) ──► COMMITTED (Effects Applied Once)
                                       │
                                       └── (Signing / Exec Failed) ─────► FAILED (State Preserved; Safe to Retry)
```

- **`in_flight`**: The signing request is currently being processed by the signer or wallet. Concurrent submissions with the same `operationId` are detected and rejected (`DUPLICATE_SUBMISSION_IN_PROGRESS` or `DuplicateSubmissionError`).
- **`committed`**: Signing succeeded and atomic effects were committed. Replaying the submission returns the cached `signedXdr` without re-prompting the wallet or applying state mutations twice.
- **`failed`**: Signing or execution failed (e.g., user rejected wallet prompt, network timeout). State and balances are preserved untouched. The operation is marked failed so subsequent retries can proceed safely.
- **`rejected`**: Pre-submission validation failed. No effects are applied, and state and balances remain intact.

### 3. Duplicate Handling Scenarios

| Scenario | Input Condition | Outcome | State / Balance Impact |
|---|---|---|---|
| **Normal submission** | New `operationId` | Signs XDR, records `committed` | State updated atomically |
| **Duplicate replay** | Same `operationId` + same payload | Returns cached `signedXdr` (`duplicate: true, replayed: true`) | Preserved untouched (no double deduction) |
| **Concurrent duplicate** | Same `operationId` while `in_flight` | Returns `DUPLICATE_SUBMISSION_IN_PROGRESS` / throws `DuplicateSubmissionError` | Preserved untouched |
| **Identity conflict** | Same `operationId` with different payload | Returns `OPERATION_IDENTITY_CONFLICT` / throws `SignerOperationConflictError` | Preserved untouched |
| **Validation failure** | Pre-sign validator returns string / false | Returns `VALIDATION_FAILED` / throws `SignerValidationError` | Preserved untouched |
| **Execution failure** | Wallet rejected or network error | Returns `EXECUTION_FAILED` (isRecoverable: true) | Preserved untouched |
| **Safe retry** | Retry after failure with same/new ID | Executes signing cleanly once resolved | State updated on success |

### 4. State & Balance Preservation Guarantees

- **Atomicity**: Local account state (e.g. balances, allowances, nonces) is only updated upon successful signing and execution via `onSuccessStateUpdate`.
- **Zero Partial Updates**: If validation fails or the signer throws at any point, the caller's original state is returned unchanged.
- **No Double Application**: On repeated calls with the same `operationId`, previously committed effects are replayed, and `onSuccessStateUpdate` is not executed again.

## Usage Examples

### Direct Signer with Operation ID

All built-in signer adapters (`ServerKeypairSigner`, `CustomSigner`, `FreighterSigner`) accept `operationId` in their options:

```typescript
import { ServerKeypairSigner } from '@stellaryield/sdk';

const signer = ServerKeypairSigner.fromSecret('S...');

// First call signs the transaction
const signedXdr1 = await signer.signTransaction(unsignedXdr, {
  networkPassphrase: 'Test SDF Network ; September 2015',
  operationId: 'deposit-user123-step1',
});

// Duplicate call returns cached signature without re-signing
const signedXdr2 = await signer.signTransaction(unsignedXdr, {
  networkPassphrase: 'Test SDF Network ; September 2015',
  operationId: 'deposit-user123-step1',
});

console.log(signedXdr1 === signedXdr2); // true
```

### Safe Execution with Atomic State Updates

Use `executeSafeSignerSubmission` to execute a transaction with state preservation and retry handling:

```typescript
import { executeSafeSignerSubmission } from '@stellaryield/sdk';

const result = await executeSafeSignerSubmission({
  signer,
  unsignedXdr,
  networkPassphrase: 'Test SDF Network ; September 2015',
  operationId: 'payment-tx-001',
  currentState: { balance: 10_000n, pendingTx: null },
  validate: (state) => {
    if (state.balance < 100n) return "Insufficient funds";
    return true;
  },
  onSuccessStateUpdate: (state, signedXdr) => ({
    balance: state.balance - 100n,
    pendingTx: signedXdr,
  }),
});

if (result.success) {
  console.log(`Success! New balance: ${result.state.balance}, Replayed: ${result.replayed}`);
} else {
  console.error(`Failed (${result.errorCode}): ${result.error}. Balance preserved: ${result.state.balance}`);
}
```

### Wrapping Any Signer with `IdempotentSignerAdapter`

Any third-party or custom signer implementing `SignerAdapter` can be decorated with duplicate submission protection:

```typescript
import { IdempotentSignerAdapter } from '@stellaryield/sdk';

const idempotentSigner = IdempotentSignerAdapter.wrap(anySigner);
const signedXdr = await idempotentSigner.signTransaction(unsignedXdr, {
  networkPassphrase: '...',
  operationId: 'tx-unique-id',
});
```

### PreparedTransaction Lifecycle Integration

When driving Soroban transactions through `PreparedTransaction`, pass `operationId` to `.sign()`:

```typescript
const prepared = await vault.deposit.prepare({ from, amount: 1_000_000n });
const signed = await prepared.sign(signer, { operationId: 'vault-deposit-tx-42' });
```

## Error Handling

New error classes exported from `@stellaryield/sdk`:

- **`DuplicateSubmissionError`**: Thrown when a duplicate submission is attempted while an operation is already `in_flight`.
- **`SignerOperationConflictError`**: Thrown when an existing `operationId` is reused with different transaction parameters (different XDR or network).
- **`SignerValidationError`**: Thrown when pre-sign validation fails before invoking the underlying signer.
