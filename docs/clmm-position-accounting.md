# CLMM position accounting: partial completion and retries

`contracts/clmm_core` tracks liquidity positions and moves tokens. A mint has to
update two ticks, the pool liquidity, a position and two token balances; a
collect has to settle two payouts. This guide describes how the contract keeps
accounting consistent when one of those steps fails, and how clients retry.

Source: `contracts/clmm_core/src/operation.rs`, `contracts/clmm_core/src/lib.rs`.

## Journal model

Every state-changing position call (`mint`, `burn`, `collect`) writes a
`PendingOperation` entry to persistent storage before it touches accounting
state. The entry holds:

| Field | Purpose |
| ----- | ------- |
| `owner`, `kind`, `position_id` | Which operation is running for whom |
| `step` | Furthest stage reached (`prepared` → `ticks updated` → `accounting updated` → `transfers settled`) |
| `transfers_settled` | Bitmask of the token transfers that already settled (`1` = token0, `2` = token1) |
| `tick_lower_before`, `tick_upper_before`, `liquidity_before` | Pre-operation tick and pool liquidity snapshot |
| `position_before`, `has_position_before` | Pre-operation position snapshot, empty for a mint |
| `amount_0`, `amount_1` | Deposits (mint) or payouts (burn on accrual, collect on settlement) |

The entry is removed only after the operation commits. `get_pending_operation(owner)`
returns it for diagnostics; it is `None` between transactions because a failed
operation is rolled back before the call returns.

## Rollback rules

`operation::rollback` replays the journal in reverse, keyed by `step`:

- **Mint** — remove the provisional position, restore pool liquidity, restore
  both tick slots, then refund any deposit that already settled. The reserved
  position id is not consumed, so a retry receives the same id and the position
  sequence never has gaps.
- **Burn** — restore the position snapshot (liquidity and accrued owed
  balances), pool liquidity and both tick slots.
- **Collect** — keep the payouts that settled and restore only the side that did
  not. Owed balances are cleared before the transfer, so a retry can never pay
  the same fees twice.

Validation failures (bad tick range, zero amount, oversized deposit, unknown
position) return before the journal is opened, so they never write state.

## Transfer failures

Token transfers use `try_transfer`, so a failing token contract is reported as
`TokenTransferFailed` (error 11) instead of trapping the whole call. This lets
the journal roll back and return a typed error.

A journal entry is also a lock: while it exists, any other `mint`, `burn` or
`collect` for that owner returns `OperationPending` (error 10). That rejects
re-entrant calls made by a token contract in the middle of a settlement.

## Events

| Topic | Data | When |
| ----- | ---- | ---- |
| `mint` | `(position_id, owner, tick_lower, tick_upper, amount)` | After the mint commits |
| `burn` | `(position_id, amount, amount0, amount1)` | After the burn commits |
| `collect` | `(position_id, amount0, amount1)` | After both payouts settle |
| `rollback` | `(kind, position_id, step)` | When a failed operation was rolled back |

A rolled-back call emits `rollback` and no `mint`/`burn`/`collect` event.

## Retry recipes

- **Mint failed** — read the error, top up the missing token balance or raise
  `amount0_max`/`amount1_max`, then call `mint` again. The retry reuses the
  reserved id; no cleanup call is needed.
- **Burn failed** — the position is unchanged. Re-read it and burn at most its
  current `liquidity`.
- **Collect failed with `TokenTransferFailed`** — the unpaid `tokens_owed_*`
  stayed on the position. Once the pool can pay (typically after the missing
  token balance is restored), call `collect` again to settle the remainder. The
  side that already settled is not paid twice.

## Tests

```bash
cd contracts
cargo test -p clmm_core
```

`contracts/clmm_core/src/lib.rs` covers the normal paths plus a failed deposit,
a failed mint against an existing position, invalid burns, and a failed collect
followed by a retry.
