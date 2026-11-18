# CLMM Position Operation Identities and Concurrency Control

`contracts/clmm_core` lets owners mint, burn and collect position liquidity.
Every one of those calls changes position accounting, and concurrent or retried
submissions must execute safely without corrupted state or double execution.
Calls carry a caller-generated **operation identity** for deduplication and an
**expected sequence number** for optimistic concurrency control.

## Protected entry points

| Entry point | Effect | Concurrency & Identity scope |
|---|---|---|
| `mint(owner, tick_lower, tick_upper, amount, amount0_max, amount1_max, operation_id)` | Creates a position, initializes sequence to `1`, and pulls tokens | `owner` + mint + position `0` (no id exists yet) |
| `burn(position_id, amount, expected_sequence, operation_id)` | Verifies `sequence == expected_sequence`, removes liquidity, accrues owed tokens, and advances sequence | `position.owner` + burn + `position_id` |
| `collect(position_id, expected_sequence, operation_id)` | Verifies `sequence == expected_sequence`, pays accrued fees/owed tokens, resets checkpoints, and advances sequence | `position.owner` + collect + `position_id` |

`swap` is not protected: it is an exact, single-shot trade with slippage bounds
and no position accounting, and it is outside the scope of this change.

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

## Events

Each consumed identity and sequence transition publishes events:

| Topic | Data | Notes |
|---|---|---|
| `("mint",)` | `(position_id, owner, tick_lower, tick_upper, amount)` | Position creation event |
| `("burn",)` | `(position_id, amount, amount0, amount1)` | Liquidity burn event |
| `("collect",)` | `(position_id, collect_0, collect_1)` | Fee collection event |
| `("pos_seq",)` | `(position_id, sequence)` | Sequence transition event emitted on mint (1), burn, and collect |
| `("op",)` | `(owner, kind, position_id, operation_id)` | Consumed operation identity event for indexer deduplication |

## Storage

| Key | Class | Notes |
|---|---|---|
| `Token0`, `Token1`, `Fee`, `TickSpacing`, `CurrentTick`, `SqrtPriceX96`, `Liquidity`, `FeeGrowthGlobal0X128`, `FeeGrowthGlobal1X128`, `NextPositionId`, `Initialized` | instance | Pool configuration and globals |
| `Position(id)` | persistent | Position accounting, including `sequence: u64` |
| `Tick(tick)` | persistent | Tick liquidity and fee-growth checkpoints |
| `Operation(operation_key)` | persistent | Consumed identity receipt; explicit TTL as described above |

See [storage-ttl-strategy.md](./storage-ttl-strategy.md).

## Breaking API changes

- `burn` and `collect` gain an `expected_sequence: u64` parameter before `operation_id: BytesN<32>`.
- `Position` includes a new field `sequence: u64` (initialized to `1` on `mint`).
- `ClmmCore` exposes a new view function `get_position_sequence(position_id) -> Result<u64, ClmmError>`.
- `ClmmError` gains `ConcurrentModification = 11`.
- A new event `("pos_seq",)` is emitted with `(position_id, sequence)`.

See `contracts/ERROR_CODES.md` for the full error table.
