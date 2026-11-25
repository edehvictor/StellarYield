# SDK Simulation API — Network, Ledger & Version Binding

This document describes how `@stellaryield/sdk` binds simulation reads and
writes to an explicit network / ledger / contract-version context and rejects
transitions between them (Issue #1857). It complements the configuration
fingerprinting described in [`sdk-simulation-config-fingerprint.md`](./sdk-simulation-config-fingerprint.md).

## Why

A simulation preview (shares out, fees, footprint, auth entries) is only valid
for the deployment it was evaluated against. Common transitions that silently
invalidate it:

| Transition | Example | Risk |
| --- | --- | --- |
| Network switch | Wallet moves from testnet to mainnet | Signing a testnet preview for mainnet |
| Passphrase drift | `network: "mainnet"` paired with the testnet passphrase | Transaction signed for the wrong chain |
| Contract / version change | Contract redeployed or bindings spec hash changed | Preview decoded with the wrong interface |
| Ledger regression | Fallback RPC node is lagging, or a local network was reset | Reads come from an older / different chain state |
| Ledger expiry | Ledger advanced past `validUntilLedger` | Submission fails or applies stale assumptions |

## The context

```ts
interface SimulationContextInput {
  network?: string;          // "testnet" | "mainnet" | "local"
  networkPassphrase?: string;
  contractId?: string;
  contractVersion?: string;  // e.g. YIELD_VAULT_SPEC_HASH
  ledger?: number;           // ledger the reads were taken at / current ledger
}
```

`bindSimulationContext(input)` validates and deep-freezes a context:

- unknown network ids throw `UnsupportedNetworkError`;
- empty strings, negative / fractional / non-finite ledgers, and a passphrase
  that does not belong to the declared `testnet` / `mainnet` network throw a
  non-retryable `SimulationContextMismatchError` with `reason: "invalid"`.
  `local` accepts any passphrase.

Only fields present on the **expected** context are bound. A bound field the
live context cannot confirm is reported as `missing`.

## Rejection rules

| Field | Reason | Retryable | Notes |
| --- | --- | --- | --- |
| `network`, `networkPassphrase`, `contractId`, `contractVersion` | `mismatch` / `missing` | **No** | Retrying would target another deployment |
| any | `invalid` | No | Malformed input |
| `ledger` | `ledger-regressed` | Yes | Live ledger is below the bound ledger |
| `ledger` | `ledger-expired` | Yes | Past `validUntilLedger` or `maxLedgerDrift` |

All mismatches throw `SimulationContextMismatchError`
(`code: "SIMULATION_CONTEXT_MISMATCH"`) with `field`, `reason`, `expected`,
`actual`, `attempts`, `phase`, `retryable`, `statePreserved: true`, and the
optional `preservedState` snapshot. `toSimulationError` passes it through
unchanged, and `isSimulationContextMismatchError` recognizes it across
package boundaries.

## API

### Pure checks

- `compareSimulationContext(expected, actual, { maxLedgerDrift?, validUntilLedger? })` → first mismatch or `null`.
- `assertSimulationContext(expected, actual, options)` → throws on mismatch.
- `simulationContextMatches(expected, actual, options)` → boolean.

### `runWithSimulationContext`

Reads the live context before and after the simulation work and verifies no
transition happened while it was in flight:

```ts
const { result, context, attempts } = await runWithSimulationContext({
  readContext: () => ({ ...client.getSimulationContext(), ledger: currentLedger() }),
  expected: client.getSimulationContext(),
  run: (ctx) => client.deposit({ from, amount }),
  maxLedgerDrift: 20,
  onTransition: "refresh", // or "reject" (default)
  maxAttempts: 3,          // clamped to [1, 10]
  stateSnapshot: balances, // echoed back, frozen, on failure
});
```

- Identity mismatches always reject, even under `refresh`.
- Retryable ledger transitions reject under `reject` and are re-run under
  `refresh`, up to `maxAttempts`. `onRefresh` is called before each retry.
- Errors thrown by `run` propagate unchanged and are never retried here.

### Prepared / signed transactions

`VaultClient` accepts an optional `network` in its config. It is validated
against `networkPassphrase` at construction (a mismatch throws before the
client exists) and recorded as `meta.network` on every prepared transaction.
`client.getSimulationContext()` returns the client's identity context.

Before signing or submitting, pass the caller's *current* context:

```ts
const live = { ...client.getSimulationContext(), ledger: await currentLedger() };

prepared.assertContext(live);                                   // explicit check
const signed = await prepared.sign(signer, { expectedContext: live });
await signed.submit(server, { expectedContext: live });
```

Identity fields must equal what the transaction was simulated for, and
`ledger` must lie within `[meta.latestLedger, meta.validUntilLedger]`.

## State preservation & safe retry

Every check runs **before** side effects:

- `sign` rejects before the signer is invoked.
- `submit` rejects before the duplicate-submission registry is consulted or
  written and before any RPC call, so a corrected retry submits normally and
  the idempotency guarantees from #1853 are unaffected.
- `runWithSimulationContext` never mutates `stateSnapshot`; it returns a
  frozen copy on both success and failure.

## Compatibility

All new options are optional. Without `expectedContext`, `sign` / `submit`
behave exactly as before. Metadata from clients configured without `network`
omits `meta.network`; pinning `network` against such metadata reports
`reason: "missing"` rather than silently passing.
