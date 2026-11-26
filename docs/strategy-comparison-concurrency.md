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


---

## Partial completion and retry (#1923)

A client that loses a response (timeout, dropped connection, 5xx from a proxy)
cannot tell whether its write was kept. The server keeps a journal of keyed
writes so the answer is always recoverable and a retry never applies twice.

### Journal

Every write that carries an operation identity (`Idempotency-Key`,
`X-Operation-Identity` or body `operationIdentity`) is recorded per wallet and
per kind (`update` for `PUT /comparison/state`, `select` for
`POST /comparison/select`):

| Outcome | Journal entry | Retrying the same identity |
| --- | --- | --- |
| Committed | `committed`, with the resulting state and version | Replays the stored result (`X-Idempotent-Replayed: true`), even if other writers moved the version since |
| Validation failure (400) | `failed`, `INVALID_STRATEGY_COMPARISON_STATE` | Executes again |
| Version conflict (409) | `failed`, `STRATEGY_COMPARISON_VERSION_CONFLICT` | Executes again |
| Side effect threw | `failed`, the error's `code`; state and balances rolled back | Executes again |

`baseVersion` on each entry is the version the workspace was at when the
attempt ran. For a failed entry it is the version the store was left at, so
the caller knows nothing was kept.

### Rules

- **One identity, one request.** Reusing an identity for a different request
  returns `422 STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH` and writes nothing.
  Requests are compared after sorting keys and dropping absent fields. For
  `select` the request is `{ strategyId, allocationUsd }`, not the derived
  balances, so a retry still matches after other writers changed balances.
- **Identities are scoped to the wallet.** The same identity used by two
  wallets is two operations; one wallet can never replay another's state.
- **Replay wins over the version check.** A retry of a committed write carries
  its original `expectedVersion`; it replays instead of failing with 409.

### Outcome lookup

`GET /api/strategies/comparison/operations/:walletAddress/:operationIdentity[?kind=update|select]`

- `200 { status: "committed", version, state, baseVersion, attempts }`
- `200 { status: "failed", errorCode, baseVersion, attempts }`
- `404 STRATEGY_COMPARISON_OPERATION_NOT_FOUND`: never recorded; retrying is safe.

### Client

- `saveComparisonStateVersioned` and `selectStrategySafely` always send an
  identity (generated when the caller gives none) and resend the identical
  request with the same identity after a network error or 5xx (two extra
  sends by default, after 250 ms and 750 ms). A 409, 422 or other 4xx is final
  and never resent.
- When no send gets an answer they throw `StrategyComparisonOutcomeUnknownError`
  with the `operationIdentity`. Resolve it with
  `fetchComparisonOperation(wallet, operationIdentity)` or send the same change
  again with the same identity.
- A 422 throws `StrategyComparisonIdempotencyMismatchError`.
- `updateComparisonSafely` uses a new identity for each conflict attempt,
  because the change is recomputed against newer state and is a different
  request.
- The comparison page keeps one identity per intended selection. If a
  selection cannot be confirmed, the page keeps the current selection, says so,
  and selecting the same strategy again reuses the identity.

### Tests

- Server: `server/src/__tests__/strategyComparisonRetry.test.ts`
- Client: `client/src/features/strategies/__tests__/strategyComparisonRetry.test.ts`
