# Yield display — duplicate submission protection

> Issue: [#1872](https://github.com/edehvictor/StellarYield/issues/1872)

Yield displays (the interactive yield curve and the net-yield figures behind
`GET /api/yields`) now carry an **immutable operation identity**. A retry of the
same logical display request returns the original committed result instead of
applying the same effect twice, and failed validation or execution leaves the
existing display state and balances untouched.

## Operation identity

The shared contract lives in
[`shared/types/yieldDataDisplayOperation.ts`](../shared/types/yieldDataDisplayOperation.ts).

| Field | Meaning |
| --- | --- |
| `operationId` | Stable token for one logical display request (`ydisp_…`). |
| `payloadFingerprint` | SHA-256 over the canonicalized payload (scope, horizon, principal, compounding, fee drag, sorted allocations, gross APY/protocols, assumptions, config version). |
| `shortId` | Compact display/audit form. |
| `createdAt` | ISO timestamp used for bounded in-memory retention. |

`createYieldDisplayOperationIdentity()` creates a fresh identity; pass an
`operationId` to restore one. `resolveYieldDisplayOperationIdentity()` reuses a
previous identity only when its fingerprint still matches the payload, so
edited assumptions can never reuse an old identity.

## Duplicate handling

| Situation | Result | State change |
| --- | --- | --- |
| Normal submission | Effect runs once and the result is committed. | Yes, once |
| Same identity replayed | Original result and effects returned with `replayed: true`; in-memory replay count increases. | No |
| Same identity, different payload | `YIELD_DISPLAY_OPERATION_IDENTITY_CONFLICT`. | No |
| Concurrent duplicate | `DUPLICATE_YIELD_DISPLAY_IN_PROGRESS`. | No |
| Validation failure | `YIELD_DISPLAY_VALIDATION_FAILED`; effect never runs. | No |
| Execution failure | `YIELD_DISPLAY_EXECUTION_FAILED`; retry with the same identity is safe. | No |

## Client flow (Yield Curve Explorer)

The explorer keeps a committed projection snapshot separate from the live
projection preview. Selecting **Commit snapshot** runs the projection through
`commitYieldDisplaySnapshot()`, which:

1. builds a canonical payload from the horizon and assumptions;
2. resolves the identity stored with the current snapshot, or creates a new one
   when the payload changed;
3. validates and executes through `YieldDisplayOperationManager`;
4. commits the new snapshot only on success, preserving the previous snapshot
   and balances on failure.

Double-clicking **Commit snapshot** therefore renders the same snapshot and
marks the second attempt as `replayed`; it does not commit a second effect.

## Server flow (`GET /api/yields`)

Clients may send `X-Operation-Identity` (8–128 characters, `A-Za-z0-9_-`).
The middleware in
[`server/src/middleware/yieldDisplayOperation.ts`](../server/src/middleware/yieldDisplayOperation.ts)
rejects malformed values with 400 `INVALID_YIELD_DISPLAY_OPERATION_IDENTITY`
before any yield data is read, and echoes accepted values on the response.

With a valid header the route binds the identity to the request assumptions and
current yield feed, then computes net yields through the same manager. A retry
returns the original response with `X-Yield-Display-Replayed: true`; a reused
identity with different assumptions returns 409. Failures return a typed error
response without cache headers, so a safe retry can recompute from unchanged
state. Omitting the header keeps the legacy behavior.

## State preservation

- Validation failures never call `execute` and return the caller's original
  state object unchanged.
- Execution failures return the original state object unchanged and mark the
  operation `failed`; retrying with the same identity recomputes the effect once
  and commits it.
- Committed replays return the stored result and effects but the caller's state
  object is not updated again.

The manager is intentionally in-process and bounded by a 24-hour TTL. It is
not a distributed lock; use the server's `Idempotency-Key` middleware or a
durable unique index when cross-process guarantees are required.

## Tests

- `shared/types/yieldDataDisplayOperation.test.ts` — identity, canonicalization,
  normal run, replay, conflict, in-flight duplicate, validation/execution
  failure and safe retry.
- `client/src/features/yield_curve/__tests__/yieldDisplayOperation.test.ts` —
  snapshot commits, preserved state, safe retry, changed payload.
- `client/src/features/yield_curve/__tests__/YieldCurveExplorer.test.tsx` —
  duplicate double-click and invalid-assumption regression coverage.
- `server/src/__tests__/yieldDisplayOperation.test.ts` — header validation,
  echo, replay, conflict and failure/retry behavior.
