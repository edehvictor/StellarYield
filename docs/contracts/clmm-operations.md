# CLMM Position Operation Identities

`contracts/clmm_core` lets owners mint, burn and collect position liquidity.
Every one of those calls changes position accounting, and a retried submission
must not apply the same effect twice. Each call therefore carries a
caller-generated **operation identity**, and the contract rejects any identity
it has already consumed.

## Protected entry points

| Entry point | Effect | Identity scope |
|---|---|---|
| `mint(owner, tick_lower, tick_upper, amount, amount0_max, amount1_max, operation_id)` | Creates a position and pulls tokens | `owner` + mint + position `0` (no id exists yet) |
| `burn(position_id, amount, operation_id)` | Removes liquidity and accrues owed tokens | `position.owner` + burn + `position_id` |
| `collect(position_id, operation_id)` | Pays accrued fees/owed tokens and resets fee checkpoints | `position.owner` + collect + `position_id` |

`swap` is not protected: it is an exact, single-shot trade with slippage bounds
and no position accounting, and it is outside the scope of this change.

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
2. The identity is then checked. If a successful call already consumed it, the
   call fails with `DuplicateOperation` (10) **before any transfer or state
   write**.
3. The identity is recorded only after the operation's transfers and state
   writes have completed. A call that fails or panics reverts the whole
   invocation — including the receipt — so a failed attempt does **not**
   consume the id and can be retried unchanged.
4. Successful receipts live in persistent storage with an explicit TTL: they are
   refreshed once less than ~1 day of ledgers remains and are kept for ~30 days
   (`OPERATION_TTL_THRESHOLD = 17_280`, `OPERATION_TTL_EXTEND_TO = 518_400` at
   ~5 second ledgers). A retry within that window is rejected; after the receipt
   expires the id is no longer recognized, so clients should not reuse ids for
   new operations.

### Client recipe

- Generate one id per logical operation and persist it before submitting.
- Retry with the **same** id after a transport failure or an error response that
  is not `DuplicateOperation`; the contract either applies it once or tells you
  it was already applied.
- After `DuplicateOperation`, treat the operation as already applied and read
  the position — do not submit it again with a new id.
- After any other error, fix the cause (caps, liquidity, tick range) and retry
  with the same id.

## Events

Each consumed identity publishes, after the existing operation event:

| Topic | Data |
|---|---|
| `("op",)` | `(owner, kind, position_id, operation_id)` |

`kind` is `mint`, `burn` or `collect`. The existing `("mint",)`, `("burn",)` and
`("collect",)` event payloads are unchanged; the `op` event lets indexers
correlate retries with the effect that was applied once.

## Storage

| Key | Class | Notes |
|---|---|---|
| `Token0`, `Token1`, `Fee`, `TickSpacing`, `CurrentTick`, `SqrtPriceX96`, `Liquidity`, `FeeGrowthGlobal0X128`, `FeeGrowthGlobal1X128`, `NextPositionId`, `Initialized` | instance | Pool configuration and globals |
| `Position(id)` | persistent | Position accounting |
| `Tick(tick)` | persistent | Tick liquidity and fee-growth checkpoints |
| `Operation(operation_key)` | persistent | Consumed identity receipt; explicit TTL as described above |

See [storage-ttl-strategy.md](./storage-ttl-strategy.md).

## Breaking API changes

`mint`, `burn` and `collect` gain a trailing `operation_id: BytesN<32>`
parameter. Clients must supply a unique id per logical operation and treat
`DuplicateOperation` as "already applied". `ClmmError` gains
`DuplicateOperation = 10`.

See `contracts/ERROR_CODES.md` for the full error table.
