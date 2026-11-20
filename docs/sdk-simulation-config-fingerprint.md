# SDK Simulation API — Immutable Configuration Fingerprints & Stale Snapshot Hardening

This document outlines the architecture, fingerprinting model, stale snapshot rejection, and state preservation guarantees implemented in `@stellaryield/sdk` for simulation APIs (Issue #1851).

## Background

Simulation previews (deposit allocation, fee estimation, expected output, slippage bounds, Soroban footprint, resource fee) are only valid relative to the configuration snapshot under which they were computed (network, strategy, protocol weights, fee rates, pricing assumptions, contract versions).

When configuration changes while a simulation is in flight — or when a caller reuses a cached simulation computed against an older configuration snapshot — the simulation output is stale and must not be applied or committed over live state.

## Architecture & Lifecycle

### 1. Canonical Fingerprint Derivation

The simulation configuration is fingerprinted using a deterministic, domain-separated 64-bit FNV-1a digest over canonical JSON:

```
fingerprint = "simcfg1:" || fnv1a64(canonicalJson(config))
```

- **Prefix**: `simcfg1:` ensures domain separation and versioning.
- **Key Ordering**: Object keys are recursively sorted so key permutation does not affect the fingerprint.
- **Numbers & BigInts**: Numbers are validated for finiteness (`-0` normalized to `0`); bigints are serialized safely as `<value>n`.
- **Privacy & Safety**: The fingerprint never exposes internal secrets, seeds, or confidential payloads.

### 2. Immutability & Deep Freezing

`captureSimulationConfig(config)` deep-clones the input object and recursively calls `Object.freeze()` on all objects and arrays. Callers cannot mutate a captured snapshot after creation:

```typescript
import { captureSimulationConfig } from '@stellaryield/sdk';

const snapshot = captureSimulationConfig({
  strategyId: 'blend-usdc-v1',
  networkPassphrase: 'Test SDF Network ; September 2015',
  protocolFeeBps: 15,
  maxDeposit: 1_000_000,
});

console.log(snapshot.fingerprint); // "simcfg1:2a8f9c1e0b3d4f5a"
Object.isFrozen(snapshot.config);  // true
```

### 3. Drift Rejection & Transparent Refresh

`runWithSimulationConfig` executes simulation work under a captured snapshot and checks the live configuration upon completion:

```typescript
import { runWithSimulationConfig } from '@stellaryield/sdk';

const result = await runWithSimulationConfig({
  readConfig: () => getLiveConfig(),
  stateSnapshot: userBalances,
  onStale: 'refresh', // or 'reject' (default)
  maxAttempts: 3,
  onRefresh: (event) => {
    console.log(`Refreshed from ${event.previousFingerprint} to ${event.nextFingerprint}`);
  },
  run: async (snapshot) => {
    return computeSimulationPreview(snapshot);
  },
});
```

- **`onStale: "reject"` (default)**: Throws `StaleSimulationConfigError` with `retryable: true` and `statePreserved: true`.
- **`onStale: "refresh"`**: Automatically re-captures the updated configuration snapshot and re-runs the simulation up to `maxAttempts`.

### 4. State & Balance Preservation Guarantees

If a simulation fails during validation (stale fingerprint, malformed snapshot, invalid configuration) or during network execution:

1. **No State Mutation**: Existing state and balances passed in `stateSnapshot` or managed by `StatePreservationGuard` remain untouched.
2. **Error Metadata**: Errors carry `statePreserved: true` and the original `preservedState` payload.
3. **Safe Retries**: The caller can refresh the fingerprint and safely retry without risking partial state application or phantom balance decrements.

## API Reference

### Types & Interfaces

- `SimulationConfig`: Dictionary of simulation configuration values.
- `SimulationConfigSnapshot`: Immutable `{ config, fingerprint, capturedAt }` tuple.
- `SimulationConfigFingerprint`: Formatted string matching `^simcfg1:[0-9a-f]{16}$`.
- `StaleSimulationConfigPolicy`: `"reject" | "refresh"`.

### Functions & Methods

- `captureSimulationConfig(config)`: Returns deep-frozen `SimulationConfigSnapshot`.
- `computeSimulationConfigFingerprint(config)`: Computes deterministic `simcfg1:<hex>` fingerprint.
- `assertSimulationConfigCurrent(expected, current, options)`: Throws on mismatch.
- `runWithSimulationConfig(options)`: Safe execution wrapper with staleness guards.
- `ApiClient.prototype.setSimulationConfig(config)`: Sets client simulation snapshot.
- `ApiClient.prototype.getSimulationConfigFingerprint()`: Returns current fingerprint.
- `ApiClient.prototype.simulateDeposit(params)`: Executes deposit simulation with fingerprint validation and retry support.
