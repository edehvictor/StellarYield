# @stellaryield/sdk

TypeScript SDK for building on top of StellarYield vaults. Provides typed wrappers for vault contract interactions and backend API endpoints.

## Installation

```bash
npm install @stellaryield/sdk
```

## Quick Start

### Vault Operations

Every state-changing call (`deposit`, `withdraw`, `harvest`, `rebalance`, `emergencyWithdraw`) returns a `PreparedTransaction`, not a resolved value — drive it through the transaction lifecycle yourself (`simulate` happens during `prepare()`, then `sign` -> `submit` -> `poll`/`wait`):

```typescript
import { VaultClient, ServerKeypairSigner } from '@stellaryield/sdk';

const vault = new VaultClient({
  contractId: 'CACT...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

const signer = ServerKeypairSigner.fromSecret('S...');
const from = await signer.getPublicKey();

// Deposit tokens into the vault
const prepared = await vault.deposit.prepare({
  from,
  amount: 1_000_000_000n,
  min_shares_out: 990_000_000n, // 1% slippage tolerance
});
const signed = await prepared.sign(signer);
const submitted = await signed.submit(vault.rpcUrl);
const confirmed = await submitted.wait();
console.log(`Minted ${confirmed.result} shares in ledger ${confirmed.ledger}`);

// Check your balance
const myShares = await vault.getShares(from);

// Withdraw by burning shares
const withdrawal = await (await vault.withdraw.prepare({ to: from, shares: myShares }))
  .sign(signer);
const withdrawn = await (await withdrawal.submit(vault.rpcUrl)).wait();
```

If a simulation reports expired ledger entries, it throws `RestoreRequiredError` (`error.restorePreamble`) — pass that into the exported `restoreAndRetry()` helper, then retry `prepare()`. See `src/examples/basic.ts` for a full worked example including the restore path.

### Safe retries and duplicate submissions

Every prepared operation carries an `operationId` in `prepared.meta` (and `prepared.operationId`). Pass an `idempotencyKey` to make that identity deterministic: the same key plus the same operation arguments always produces the same id, even when a retry rebuilds and re-signs the transaction with a new sequence number. The key is never placed on-chain.

```typescript
const prepared = await vault.deposit.prepare({
  from,
  amount: 1_000_000_000n,
  idempotencyKey: `deposit-${walletAddress}-${requestId}`,
});

const signed = await prepared.sign(signer);
const submitted = await signed.submit(vault.rpcUrl);

// Safe retry: the SDK reuses the original transaction hash instead of
// submitting the same effect a second time.
const retry = await signed.submit(vault.rpcUrl);
console.log(retry.deduplicated); // true
console.log(retry.hash === submitted.hash); // true
```

Submit-time behavior:

| Situation | SDK behavior |
| --- | --- |
| Same signed transaction submitted twice | `sendTransaction` runs once; the second call returns the original hash with `deduplicated: true`. |
| Rebuilt transaction with the same `idempotencyKey` and arguments | Reuses the first submitted hash; no second effect. |
| Concurrent `submit()` calls on one signed transaction | Share a single network request. |
| Transport failure or RPC `ERROR` before acceptance | The identity is **not** remembered; retrying is safe and submits normally. |
| `wait()` reports `FAILED` | The identity is forgotten because nothing landed; a corrected retry may submit again. |
| `wait()` times out with the transaction possibly pending | The identity is kept, so retrying returns the pending hash rather than submitting again. Use `recoverTransaction(hash)` to keep polling. |
| Invalid amount or argument validation failure | No transaction is built, signed, or submitted; no identity is registered. |

`prepare()` and `submit()` never mutate vault balances or existing transactions on failure. The duplicate guard is an in-process, bounded registry (and is scoped to the SDK instance's process); for idempotency across processes or restarts, persist `idempotencyKey` yourself and reuse it on retry. `resetSubmittedOperations()` clears the guard explicitly, and `lookupSubmittedOperation(id)` exposes the remembered hash for observability.

### Simulation failure diagnostics

`prepare()` is read-only: it builds and simulates a transaction but never signs, submits, or mutates vault balances. When argument validation or simulation fails, it throws without returning a partial `PreparedTransaction`, so no state or balance is changed. Errors carry privacy-safe `diagnostics` that name the failed stage and the next action:

```typescript
import {
  SimulationDiagnosticsError,
  areSimulationDiagnosticsPrivacySafe,
} from '@stellaryield/sdk';

try {
  await vault.deposit.prepare({ from, amount: 1_000_000n });
} catch (error) {
  if (error instanceof SimulationDiagnosticsError) {
    for (const diagnostic of error.diagnostics) {
      console.error(diagnostic.code, diagnostic.stage, diagnostic.remediation);
    }
    console.error('retryable:', error.retryable);
    console.assert(areSimulationDiagnosticsPrivacySafe(error.diagnostics));
  }
}
```

| Code | Stage | Meaning and remediation |
| --- | --- | --- |
| `VALIDATION_FAILED` | `input-validation` | An amount or argument was rejected before any RPC call. Correct it and retry; nothing was built or submitted. |
| `CONTEXT_INSUFFICIENT` | `simulation` | Simulation failed without a decodable contract code or diagnostic events. Retry once; if it persists, check the RPC endpoint and source-account sequence number. |
| `SIMULATION_FAILED` | `simulation` | The contract rejected the simulation with a decodable `VaultError` code. Resolve that contract error and retry. |
| `RESULT_DECODE_FAILED` | `result-decoding` | Simulation succeeded but the pinned bindings could not decode the result. Confirm `specHash` matches the deployed contract. |
| `RESTORE_REQUIRED` | `restore` | Footprint entries expired. Use `restoreAndRetry()` and then retry `prepare()`. |
| `STATE_PRESERVED` | `state-persistence` | Always appended to a failure: existing vault state and balances were untouched. |

Known typed errors keep their class: `InvalidAmountError` and `ContractExecutionError` gain a `diagnostics` array rather than being wrapped. A failure with insufficient context becomes `SimulationDiagnosticsError`. Diagnostics contain fixed template text only — never raw RPC URLs, wallet addresses, XDR, transaction hashes, or stack traces. `toSimulationError()` is exported for callers that wrap their own simulation adapter and want the same normalization.

### Token amounts

Amount arguments (`amount`, `shares`, `min_shares_out`, `min_amount_out`) take a `bigint`, a base-unit integer string, or a `number` that is a safe integer. Fractional numbers and integers above `Number.MAX_SAFE_INTEGER` throw `InvalidAmountError` before any transaction is built, because they cannot be represented exactly.

Use `toTokenUnits` to convert human-readable decimal strings and `formatTokenUnits` to display them:

```typescript
import { toTokenUnits, formatTokenUnits } from '@stellaryield/sdk';

toTokenUnits('1.5', { decimals: 7 });      // 15_000_000n
toTokenUnits('9007199254740993');          // 9007199254740993n (exact)
toTokenUnits(1.5);                         // throws InvalidAmountError
toTokenUnits(2 ** 60);                     // throws InvalidAmountError
formatTokenUnits(15_000_000n, 7);          // "1.5"
```

### API Client

```typescript
import { ApiClient } from '@stellaryield/sdk';

const api = new ApiClient({
  baseUrl: 'https://api.stellaryield.io',
});

// Get current APY
const apy = await api.getCurrentAPY('vault-contract-id');

// Get historical data
const history = await api.getHistoricalData('vault-contract-id', 30);

// Get complete vault data
const vaultData = await api.getVaultData('vault-contract-id');
```

## Features

- **VaultClient**: Interact with YieldVault Soroban contract
  - `deposit.prepare()`, `withdraw.prepare()`, `harvest.prepare()`, `rebalance.prepare()`, `emergencyWithdraw.prepare()`: build+simulate a `PreparedTransaction`
  - `getShares()`: Check user share balance
  - `totalShares()`, `totalAssets()`: Vault metrics
  - `getAdmin()`, `getToken()`, `getFlashLoanFee()`: Read-only contract state
  - `recoverTransaction(hash)`: Resume polling a previously submitted transaction

- **Lifecycle helpers**: `PreparedTransaction` -> `.sign()` -> `SignedTransaction` -> `.submit()` -> `SubmittedTransaction` -> `.wait()` -> `ConfirmedTransaction`, plus `restoreAndRetry()`/`needsRestore()` for the Soroban footprint-restore path. Errors carry a `phase` (`simulate`/`sign`/`submit`/`poll`/`restore`) and `retryable` flag. Prepared operations carry an `operationId`; pass an `idempotencyKey` to make retries duplicate-safe.

- **ApiClient**: Fetch vault metrics from backend
  - `getCurrentAPY()`: Get current APY
  - `getTVL()`: Get Total Value Locked
  - `getHistoricalData()`: Get APY/TVL history
  - `getVaultData()`: Get complete vault data
  - `configureEndpoint()`: Dynamically reconfigure endpoint parameters safely

- **Endpoint Configuration & Privacy-Safe Diagnostics**:
  - `validateEndpointConfig()` & `validateEndpointUrl()`: Validate base URLs, protocols, credentials, and retry parameters before network dispatch.
  - Privacy-safe diagnostic contract: Errors carry structured `diagnostics` with `stage`, `code`, `summary`, `remediation`, and `retryable`.
  - Secrets and credentials (passwords, tokens, secret seeds, addresses, internal paths) are automatically redacted with `privacySafe: true`.
  - State & balance preservation: Failed validations or execution outages never mutate state; every failure diagnostic includes a `STATE_PRESERVED` entry (`stage: "state-persistence"`).
  - Insufficient diagnostic context: When an endpoint returns empty, non-JSON, or missing diagnostic details, the SDK safely returns `CONTEXT_INSUFFICIENT` and indicates whether safe retry is possible.
  - `simulateDeposit()`: Preview deposit allocation, shares, and fee estimates
  - `simulateWithConfig()`: Execute simulation under immutable configuration snapshot

- **Simulation Configuration & Fingerprint Hardening**:
  - `captureSimulationConfig(config)`: Captures a deep-frozen, immutable snapshot of simulation parameters and derives a deterministic `simcfg1:<hex>` fingerprint.
  - `assertSimulationConfigCurrent(expected, current)`: Rejects stale configuration snapshots with typed, retryable `StaleSimulationConfigError`.
  - `runWithSimulationConfig(options)`: Runs simulation against an immutable snapshot, detects configuration drift, and either rejects (`onStale: "reject"`) or transparently re-runs (`onStale: "refresh"`).
  - State & Balance Preservation: Validation and execution failures never modify existing balances or state; every failure maintains `statePreserved: true`.

`ApiClient.simulateDeposit()` also checks the configuration after each request. With
`onStale: "refresh"`, it retries under the latest snapshot up to `maxAttempts`
(default 3, capped at 10); it never returns a response whose configuration changed
in flight. On exhaustion, `StaleSimulationConfigError` includes the expected and
actual fingerprints, completed `attempts`, and `preservedState` when supplied, so
callers can refresh and retry with a known state snapshot. Successful responses
include `simulationAttempts`. This retry is for read-only simulations and does not
apply deposits or change balances.

## Deposit simulation fixtures

Offline tests can import `depositSimulationScenarios` and `createDepositSimulation`
from `test/fixtures/depositSimulation.ts`. Scenarios cover a first deposit, an
existing vault's non-1:1 share ratio, and amounts above `Number.MAX_SAFE_INTEGER`.
Every amount is a decimal string in base units; parse with `toTokenUnits`/`BigInt`,
never `Number`. Each factory call returns fresh XDR and transaction-data objects
compatible with `rpc.Api.SimulateTransactionSuccessResponse`.

| Field | Meaning |
| --- | --- |
| `amount` | Vault tokens deposited, in token base units. |
| `minSharesOut` | Requested slippage floor, in share base units. |
| `mintedShares` | Expected deposit return value, encoded as an i128 `ScVal`. |
| `minResourceFee` | Simulated Soroban resource fee in stroops, also present in `transactionData`; excludes the classic inclusion fee and the token principal. |
| `reserveBefore`, `reserveAfter` | Test-only idle-token balance snapshots for an ordinary deposit with no concurrent strategy movement: `after = before + amount`. These are not RPC response fields, total portfolio assets, a live quote, or a claim about spendable XLM reserves. |

The fixtures do not contact RPC, sign, submit, or export new production APIs.
Run `npm test -- test/depositSimulation.test.ts` from `packages/sdk`; `npm test`
runs the complete SDK suite.

## License

MIT
