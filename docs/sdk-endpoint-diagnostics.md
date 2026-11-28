# SDK Endpoint Configuration & Diagnostic Context Hardening

## Overview

SDK consumers and client applications interact with backend services and Soroban RPC nodes through configured endpoints (`ApiClient` and `VaultClient`). When an endpoint configuration is malformed, network connectivity drops, or a server/node failure occurs, developers and operators need actionable insight into **which stage failed** and **what remediation path to take**.

Previously, endpoint failures returned bare error strings or unhandled exceptions without structured stage diagnostics. When diagnostic context was insufficient (e.g. empty response bodies, stripped headers, or opaque 5xx status codes), callers could not tell which lifecycle stage was reached or whether retrying was safe.

The SDK now enforces a canonical privacy-safe diagnostic contract that safely handles insufficient diagnostic context, guarantees existing state and balances are preserved, and provides clear retry guidance.

## Diagnostic Shape

Each diagnostic emitted by `packages/sdk` adheres to the following contract:

| Field | Description |
| :--- | :--- |
| `code` | Stable machine-readable code: `CONTEXT_INSUFFICIENT`, `VALIDATION_FAILED`, `ENDPOINT_UNAVAILABLE`, `STATE_PRESERVED`, `RETRY_UNSAFE`, or `CONFIG_VERSION_CONFLICT`. |
| `stage` | The lifecycle stage where failure occurred. |
| `severity` | Diagnostic severity tier: `info`, `warning`, or `critical`. |
| `summary` | Operator-facing explanation with all credentials, URLs, and secrets redacted. |
| `remediation` | Specific next action to take. |
| `retryable` | Boolean indicating whether repeating the operation is safe. |
| `privacySafe` | Literal `true`, verifying compliance with privacy guarantees. |
| `affectedStages` | Optional list of related stages affected by the failure. |

### Lifecycle Stages

- `endpoint-configuration`: Validating endpoint URLs, protocols, credentials, and retry parameters.
- `request-validation`: Parameter and payload validation prior to network dispatch.
- `network-dispatch`: HTTP/RPC transport to the endpoint.
- `response-decoding`: Parsing and validating the response body/schema.
- `simulate`: Soroban transaction simulation.
- `sign`: Transaction signing with wallet/keypair adapter.
- `submit`: Submitting transaction to the network.
- `poll`: Awaiting transaction inclusion and finality.
- `restore`: Expired ledger entry footprint restoration.
- `state-persistence`: Verifying that prior client/account state and balances are untouched.

## Insufficient Diagnostic Context

When an endpoint returns an error lacking adequate diagnostic context (such as an empty body, HTML error page, or omitted diagnostic events):

1. The SDK catches the failure and builds a `CONTEXT_INSUFFICIENT` diagnostic for the relevant stage.
2. The diagnostic is accompanied by a `STATE_PRESERVED` entry (`stage: "state-persistence"`), confirming that no partial state was applied.
3. Remediation instructions specify verifying endpoint availability and configuration context.

## State Preservation Guarantee

A critical requirement of the SDK is that failed validations or executions must never mutate client state or account balances:
- **Configuration Validation**: If `new ApiClient()` or `client.configureEndpoint()` fails validation, the invalid configuration is rejected and any existing configuration is preserved.
- **Cache Storage**: `cachedGet()` maintains previously cached payloads intact if the remote endpoint fails.
- **Amount Validation**: Token amount checks execute before simulation; invalid inputs throw `InvalidAmountError` with `STATE_PRESERVED` without generating transactions.
- **Soroban Simulation**: Simulations run read-only on the node; failure never submits transactions to the ledger.

## Concurrent Configuration Changes

`ApiClient` and `VaultClient` store endpoint configuration in a versioned, serialized state holder. Each successful commit increments `version` (starting at 1); a validation failure, a thrown change callback, or a version conflict changes neither the configuration nor the version.

- **Read**: `getEndpointConfigState()` and `getEndpointConfigVersion()` expose a defensive snapshot. Mutating the returned config or its arrays cannot affect live state.
- **Conditional write**: `configureEndpoint(config, { expectedVersion })` commits only when the live version still matches. A mismatch throws `EndpointConfigVersionConflictError` with `expectedVersion`, `currentVersion`, `currentConfig`, and a retryable `CONFIG_VERSION_CONFLICT` diagnostic followed by `STATE_PRESERVED`.
- **Serialized async write**: `updateEndpointConfigSafely({ change, maxAttempts, onRetry })` queues read-modify-write work so concurrent callers never interleave between read and persist. A version change observed between read and persist is refreshed and retried up to `maxAttempts` (default 3). An explicit `expectedVersion` is never refreshed automatically — retry with the `currentVersion` reported by the conflict error.
- **Request pinning**: an in-flight `ApiClient` request uses one captured config snapshot for its base URL, timeout, retry count, backoff, and retryable statuses. Reconfiguration while a request is in flight applies to later requests only.

```typescript
const before = api.getEndpointConfigState();

try {
  api.configureEndpoint({ baseUrl: nextUrl }, { expectedVersion: before.version });
} catch (error) {
  if (error instanceof EndpointConfigVersionConflictError) {
    api.configureEndpoint({ baseUrl: nextUrl }, {
      expectedVersion: error.currentVersion,
    });
  }
}
```

Callers that do not need to pin a version can use `updateEndpointConfigSafely`, which re-reads the latest configuration for each bounded retry:

```typescript
await api.updateEndpointConfigSafely({
  change: async (current) => ({ timeoutMs: current.timeoutMs ?? 5000 }),
  onRetry: ({ expectedVersion, currentVersion, attempt }) =>
    console.warn("endpoint config retried", { expectedVersion, currentVersion, attempt }),
});
```

## Safe Retry Policy

- **Non-Retryable (`retryable: false`)**:
  - `VALIDATION_FAILED`: Parameter, endpoint URL, or schema errors require correcting the input before resubmission.
  - `RETRY_UNSAFE`: Operations that may have reached the network where repeating blindly could cause double execution (e.g. non-idempotent writes without idempotency keys).
- **Retryable (`retryable: true`)**:
  - `ENDPOINT_UNAVAILABLE` & `CONTEXT_INSUFFICIENT`: Network disconnects, gateway timeouts (504), rate limits (429), or transient server outages (500/502/503). Retrying with exponential backoff or switching to a backup endpoint is safe.
  - `CONFIG_VERSION_CONFLICT`: A conditional endpoint update lost a race. No configuration was persisted; reload the reported version and retry.

## Example Usage

```typescript
import { ApiClient, SdkEndpointError, areDiagnosticsPrivacySafe } from "@stellaryield/sdk";

try {
  const client = new ApiClient({
    baseUrl: "https://api.stellaryield.com",
    maxRetries: 2,
  });

  const yields = await client.getYields();
} catch (error) {
  if (error instanceof SdkEndpointError || "diagnostics" in error) {
    const diagnostics = error.diagnostics;
    console.warn("Failed stage:", diagnostics[0]?.stage);
    console.warn("Remediation:", diagnostics[0]?.remediation);
    console.warn("Retryable:", diagnostics[0]?.retryable);

    // Assert privacy safety in tests or monitoring
    assert(areDiagnosticsPrivacySafe(diagnostics));
  }
}
```
