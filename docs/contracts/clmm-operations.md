# CLMM Position Operation Identities and Concurrency Control

`contracts/clmm_core` lets owners mint, burn and collect position liquidity.
Every one of those calls changes position accounting, and concurrent or retried
submissions must execute safely without corrupted state or double execution.
Calls carry a caller-generated **operation identity** for deduplication and an
**expected sequence number** for optimistic concurrency control.

## Protected entry points

| Entry point | Effect | Concurrency & Identity scope |
|---|---|---|
| `mint(owner, tick_lower, tick_upper, amount, amount0_max, amount1_max, expected_context, operation_id)` | Verifies `expected_context`, creates a position, initializes sequence to `1`, and pulls tokens | `owner` + mint + position `0` (no id exists yet) |
| `burn(position_id, amount, expected_sequence, expected_context, operation_id)` | Verifies `expected_context` and `sequence == expected_sequence`, removes liquidity, accrues owed tokens, and advances sequence | `position.owner` + burn + `position_id` |
| `collect(position_id, expected_sequence, expected_context, operation_id)` | Verifies `expected_context` and `sequence == expected_sequence`, pays accrued fees/owed tokens, resets checkpoints, and advances sequence | `position.owner` + collect + `position_id` |
| `swap(recipient, zero_for_one, amount_specified, sqrt_price_limit_x96, expected_context)` | Verifies `expected_context` and executes an exact single-shot trade with slippage bounds | Context-bound only (no `operation_id` or `sequence`) |

## Network, ledger, and version context binding

The pool's stored state is bound to the network it was initialized on and to a
context version (`CURRENT_POOL_VERSION = 1`). Callers capture
`get_pool_context() -> Result<PoolContext, ClmmError>` (`{ network_id, contract, version }`)
and pass it as `expected_context` to `mint`, `burn`, `collect`, and `swap`.
Read views (`get_position`, `get_position_sequence`, `get_current_tick`,
`get_sqrt_price`, `get_liquidity`) enforce live network and version
compatibility via `require_live_context`.

Validation runs immediately after `require_init`, before any position load,
operation-id check, math, token transfer, or storage write:

| Mismatch | Error |
|---|---|
| Live ledger network ≠ network the stored state is bound to | `WrongNetwork` (`18`) |
| Caller's `network_id` ≠ bound network | `WrongNetwork` (`18`) |
| Caller's `contract` ≠ this deployment | `WrongContract` (`19`) |
| Stored version > `CURRENT_POOL_VERSION` (code downgrade) | `WrongVersion` (`20`) |
| Caller's `version` ≠ stored version (e.g. before/after `migrate`) | `WrongVersion` (`20`) |

A legacy pool initialized before context binding existed has no stored
`NetworkId` or `StorageVersion`; it adopts the live network at version `0` and
keeps operating unchanged until `migrate()` pins the live network and bumps
`StorageVersion` to `1` without touching positions, liquidity, or balances.
`migrate()` is idempotent and returns `WrongNetwork` rather than re-binding
state that already belongs to another network. Because context validation fails
before any state change or operation-id consumption, callers can refresh
`get_pool_context()` and retry safely with the same `operation_id`.

## Optimistic Concurrency Control (OCC)

Positions in CLMM maintain mutable state: liquidity, fee-growth checkpoints, and
uncollected owed tokens (`tokens_owed_0`, `tokens_owed_1`). When concurrent
transactions (such as concurrent burns, simultaneous collects, or automated
keeper compounding) attempt to modify the same position, they must not execute
against stale snapshots.

### Sequence lifecycle

- When a position is created via `mint()`, its `sequence` is initialized to `1`.
- Any mutating operation (`burn()` or `collect()`) requires the caller to provide
  `expected_sequence: u64`.
- If `position.sequence != expected_sequence`, the call is rejected immediately
  with `ConcurrentModification` (`11`).
- On successful update, `position.sequence` increments monotonically (`+1`) and is
  persisted to storage.
- Callers can inspect the current sequence at any time via
  `get_position(position_id)` or the lightweight view function
  `get_position_sequence(position_id)`.

### Validation order and state preservation

To preserve state integrity and avoid unnecessary gas or side effects:

1. Initialization, position existence, and owner authorization are validated first.
2. Idempotency is checked via `require_new_operation`. If the `operation_id` was
   already consumed by a prior successful transaction, `DuplicateOperation` (`10`)
   is returned.
3. The optimistic concurrency check verifies `position.sequence == expected_sequence`.
   A mismatch fails with `ConcurrentModification` (`11`) **before** computing tick
   math, modifying tick liquidity, moving tokens, or persisting state.
4. On concurrency failure, the entire invocation halts:
   - No tokens are transferred; user and pool balances remain completely intact.
   - Position liquidity, owed tokens, and checkpoints remain unchanged.
   - The caller's `operation_id` is **not** consumed, allowing an immediate safe retry.

## Identity derivation

```
operation_key = SHA-256(
    "stellaryield_clmm_op_v1" ||
    XDR(current_contract_address, owner, kind, position_id, operation_id)
)
```

`operation_id` is a `BytesN<32>` chosen by the client (for example a random
value or a hash of the off-chain intent). The domain separator plus the
preimage binding mean:

- an id consumed for one **owner** never blocks another owner;
- an id consumed for one **operation kind** is free for another kind;
- an id consumed on one **position** is free for another position (burn/collect);
- an id cannot be replayed against a different deployment of this contract.

## Retry semantics

1. Argument validation, authorization and position lookup run first, so
   malformed calls report `InvalidAmount`, `InsufficientLiquidity`,
   `InvalidPosition` or `Unauthorized` rather than a duplicate error.
2. The identity is checked. If a successful call already consumed it, the
   call fails with `DuplicateOperation` (10) **before any transfer or state
   write**.
3. The sequence is checked against `expected_sequence`. If stale, the call fails
   with `ConcurrentModification` (11) without mutating state or consuming the id.
4. The identity is recorded only after the operation's transfers and state
   writes have completed. A call that fails or panics reverts the whole
   invocation — including the receipt — so a failed attempt does **not**
   consume the id and can be retried unchanged.
5. Successful receipts live in persistent storage with an explicit TTL: they are
   refreshed once less than ~1 day of ledgers remains and are kept for ~30 days
   (`OPERATION_TTL_THRESHOLD = 17_280`, `OPERATION_TTL_EXTEND_TO = 518_400` at
   ~5 second ledgers). A retry within that window is rejected; after the receipt
   expires the id is no longer recognized, so clients should not reuse ids for
   new operations.

### Client recipe

- Query `get_position(position_id)` or `get_position_sequence(position_id)` to
  obtain the latest `sequence` snapshot.
- Generate one `operation_id` per logical operation and persist it before submitting.
- Submit `burn` or `collect` with `expected_sequence` and `operation_id`.
- If rejected with `ConcurrentModification` (11): re-fetch the latest position
  sequence, verify the new position parameters, and retry with the updated
  sequence using the same `operation_id`.
- If rejected with `DuplicateOperation` (10): treat the operation as already
  applied and read the position — do not submit it again.
- After any transport failure: retry with the same `expected_sequence` and
  `operation_id`.

## Boundary validation and stored position records

Position records live in persistent storage and can be read back after upgrades or
manual migrations, so `burn`, `collect` and `get_position` treat them as untrusted
input. A record is rejected with `CorruptedPosition` (15) — before any transfer or
state write — when it has:

- `tick_lower >= tick_upper`;
- a tick outside `[-887272, 887272]`;
- a tick that is not aligned to the pool's current tick spacing;
- `liquidity > i128::MAX` (not representable in tick accounting).

`collect` additionally rejects a stored `fee_growth_inside_*_last_x128` that is
greater than the current inside growth, which would otherwise underflow the fee
calculation.

Untrusted arguments are validated before accounting:

| Call | Checks |
|---|---|
| `initialize` | `fee <= 10_000` bps (`InvalidFee`), `1 <= tick_spacing <= 16_384` (`InvalidTickSpacing`), `sqrt_price_x96 >= MIN_SQRT_RATIO` (`InvalidSqrtPrice`) |
| `mint` | non-zero amount within the deposit caps, `amount <= i128::MAX`, aligned in-domain tick range, checked token-amount and liquidity math |
| `burn` | non-zero amount not exceeding the position's liquidity, checked owed-token accrual |
| `swap` | non-zero amount, price limit on the correct side, checked swap-step, fee-growth and signed tick-liquidity math |

Every arithmetic path uses checked operations and reports `MathOverflow` (14)
instead of panicking or wrapping. A failed call reverts atomically: no pool,
tick, position or token balance changes, and the operation identity is not
consumed, so the same id can be retried after the input or record is repaired.

## Events

Each consumed identity and sequence transition publishes events:

| Topic | Data | Notes |
|---|---|---|
| `("mint",)` | `(position_id, owner, tick_lower, tick_upper, amount)` | Position creation event |
| `("burn",)` | `(position_id, amount, amount0, amount1)` | Liquidity burn event |
| `("collect",)` | `(position_id, collect_0, collect_1)` | Fee collection event |
| `("pos_seq",)` | `(position_id, sequence)` | Sequence transition event emitted on mint (1), burn, and collect |
| `("op",)` | `(owner, kind, position_id, operation_id)` | Consumed operation identity event for indexer deduplication |
| `("migrate",)` | `(network_id, version)` | Pool context migration event |

## Storage

| Key | Class | Notes |
|---|---|---|
| `Token0`, `Token1`, `Fee`, `TickSpacing`, `CurrentTick`, `SqrtPriceX96`, `Liquidity`, `FeeGrowthGlobal0X128`, `FeeGrowthGlobal1X128`, `NextPositionId`, `Initialized`, `ConfigFingerprint`, `NetworkId`, `StorageVersion` | instance | Pool configuration, context binding, and globals |
| `Position(id)` | persistent | Position accounting, including `sequence: u64` |
| `PositionConfigFingerprint(id)` | persistent | Configuration fingerprint captured when the position was minted |
| `Tick(tick)` | persistent | Tick liquidity and fee-growth checkpoints |
| `Operation(operation_key)` | persistent | Consumed identity receipt; explicit TTL as described above |

See [storage-ttl-strategy.md](./storage-ttl-strategy.md).

## Breaking API changes

- `mint`, `burn`, `collect`, and `swap` take `expected_context: PoolContext` (before `operation_id` on `mint`/`burn`/`collect`).
- `ClmmCore` exposes `get_pool_context() -> Result<PoolContext, ClmmError>` and `migrate() -> Result<PoolContext, ClmmError>`.
- `get_current_tick`, `get_sqrt_price`, and `get_liquidity` return `Result<..., ClmmError>` so read calls reject `WrongNetwork`, `WrongVersion`, and `NotInitialized`.
- `burn` and `collect` gain an `expected_sequence: u64` parameter before `expected_context: PoolContext` and `operation_id: BytesN<32>`.
- `Position` includes a new field `sequence: u64` (initialized to `1` on `mint`).
- `ClmmCore` exposes a new view function `get_position_sequence(position_id) -> Result<u64, ClmmError>`.
- `ClmmError` includes `ConcurrentModification = 11` through `WrongVersion = 20`.
- Events `("pos_seq",)` and `("migrate",)` are emitted on sequence transitions and context migrations.

See `contracts/ERROR_CODES.md` for the full error table.
