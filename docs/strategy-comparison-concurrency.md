# Strategy comparison: concurrent state changes

Strategy comparison workspaces are per-wallet. Two tabs, two devices, or a
background sync racing an edit could previously overwrite each other silently
(last-write-wins). Since #1919 every comparison workspace record carries a
**version** and writes can be made conditional on it (optimistic concurrency
control – OCC).

## Versions

- A wallet with no existing workspace is at version `0`.
- Every committed write (`PUT /api/strategies/comparison/state`,
  `POST /api/strategies/comparison/select`) increments the version by one.
- Reads return the current version as `ETag: "<version>"` and
  `X-Comparison-Version: <version>`; `GET /api/strategies/comparison/state/:wallet`
  also includes `version` in the JSON body.

## Conditional writes

Send the version you read as `If-Match: "<version>"` (`W/"<version>"` and a
bare number are also accepted), or as `expectedVersion` in the JSON body.
`"0"` means "create only" (the wallet has no stored workspace yet).

| Situation | Response | State |
| --- | --- | --- |
| Version matches | `200`, new version in `ETag` / `X-Comparison-Version` | written |
| Concurrent writer committed first | `409 STRATEGY_COMPARISON_VERSION_CONFLICT` with `expectedVersion`, `currentVersion`, `state` | unchanged |
| Malformed fee / balance value | `400 INVALID_STRATEGY_COMPARISON_STATE` | unchanged |
| No version sent | `200` (unconditional, same as before) | written |

The version check, the write, the version bump, and any synchronous side-effect
run as a single step in the service, so no other request can interleave between
the check and the write. If a side-effect throws, the previous state and version
are restored before the error is returned.

## State & balance preservation guarantees

| Scenario | Outcome |
| --- | --- |
| Validation failure (fee out of range) | State **unchanged** – error returned to caller |
| Execution / side-effect failure | State **rolled back** to previous snapshot |
| Concurrent conflict (version mismatch) | State **unchanged** – 409 returned with server's current state |
| Idempotent replay (same operation identity) | Previous result returned, state **not written again** |
| Safe retry after conflict | Caller re-fetches latest state, re-applies change, re-submits |

## Retries and idempotency

- A retry with the same `X-Operation-Identity` / `Idempotency-Key` header
  returns the original committed result (`isReplay: true` in body,
  `X-Idempotent-Replayed: true` in headers). Nothing is written.
- Operation identities are scoped to a wallet. Reusing an identity for a
  different update on the same wallet returns `409
  STRATEGY_COMPARISON_OPERATION_IDENTITY_CONFLICT` without changing state.
- A write rejected with `409 STRATEGY_COMPARISON_VERSION_CONFLICT` does **not**
  consume its operation identity, so the caller can safely reload the newer
  state and retry with the same or a new identity.
- Validation and execution failures do not consume the identity, so a corrected
  or safe retry can use it again.

## New API endpoints (added in #1919)

### `GET /api/strategies/comparison/state/:walletAddress`

Returns the current comparison workspace state and version.

**Response headers:** `ETag: "<version>"`, `X-Comparison-Version: <version>`

**Response body:**
```json
{
  "state": {
    "walletAddress": "GWALLET…",
    "selectedStrategyId": null,
    "pinnedStrategyIds": [],
    "customAssumptions": {},
    "allocatedBalances": {},
    "updatedAt": "2026-11-19T12:00:00.000Z",
    "version": 3
  },
  "version": 3
}
```

---

### `PUT /api/strategies/comparison/state`

Conditionally updates the comparison workspace state.

**Request headers:** `If-Match: "<expectedVersion>"`, `X-Operation-Identity: <id>`, `Idempotency-Key: <id>`

**Request body:**
```json
{
  "walletAddress": "GWALLET…",
  "pinnedStrategyIds": ["blend"],
  "customAssumptions": { "protocolFeeBps": 50 },
  "expectedVersion": 3,
  "operationIdentity": "cmp-op-GWALLET-3-1-1700000000000"
}
```

**Responses:**
- `200` – state saved, `ETag` / `X-Comparison-Version` carry new version
- `400 INVALID_STRATEGY_COMPARISON_STATE` – fee or balance out of range; state unchanged
- `409 STRATEGY_COMPARISON_VERSION_CONFLICT` – concurrent write; body includes `currentVersion` and `state`

---

### `POST /api/strategies/comparison/select`

Atomically selects a strategy and updates its allocation balance under OCC.

**Request body:**
```json
{
  "walletAddress": "GWALLET…",
  "strategyId": "blend",
  "allocationUsd": 1000,
  "expectedVersion": 3,
  "operationIdentity": "sel-blend-GWALLET-3"
}
```

**Responses:** same as `PUT /api/strategies/comparison/state`

---

## Client

`client/src/features/strategies/strategyComparisonConcurrencyApi.ts`:

- `fetchComparisonStateVersioned(wallet)` → `{ state, version }`.
- `saveComparisonStateVersioned(wallet, updates, { expectedVersion, operationIdentity })`
  throws `StrategyComparisonConflictError` (with `currentVersion` and `currentState`)
  on a 409 version conflict.
- `selectStrategySafely(wallet, strategyId, allocationUsd, { expectedVersion, operationIdentity })`
  atomically selects and allocates; throws `StrategyComparisonConflictError` on 409.
- `updateComparisonSafely(wallet, changeFn, maxAttempts = 3)` reads current state,
  applies `changeFn`, saves against that version, and on a conflict re-fetches the
  server's newer state and re-applies `changeFn`. Other errors are not retried.

The read-modify-write loop in `updateComparisonSafely` ensures that a concurrent
writer's changes (e.g. a different balance entry) are **not silently discarded**
when the local writer retries — `changeFn` is re-applied to the latest server
state each time.

## Tests

- Server: `server/src/__tests__/strategyComparisonConcurrency.test.ts` (13 tests)
- Client: `client/src/features/strategies/__tests__/strategyComparisonConcurrencyApi.test.ts` (17 tests)

See also: `docs/alert-preferences-concurrency.md` for the same OCC pattern applied
to alert preferences (`#1903`).

