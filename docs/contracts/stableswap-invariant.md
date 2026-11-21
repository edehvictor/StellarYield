# StableSwap Invariant: Rounding and Numeric Limits

`contracts/stableswap` implements a two-token Curve-style StableSwap pool. This
document records the rounding rules and numeric limits that the invariant math
relies on, and what callers can expect at boundary values.

Source: `contracts/stableswap/src/lib.rs`

## Invariant

For reserves `x`, `y` and amplification `A` (`ann = 4·A`):

```
D³/(4·x·y) + ann·(x+y) = (ann + 1)·D
```

`D` is solved with Newton–Raphson from `D₀ = x + y`. `compute_y` solves the
equivalent quadratic for the counter-reserve after a swap.

## Rounding rules

All divisions are integer division of non-negative values, so they round **down**.

| Calculation | Rule | Effect |
|---|---|---|
| `D³/(4·x·y)` | Folded division-first: `floor(floor(d²/(4·max(x,y)))·d/min(x,y))` | Never exceeds the exact rational value |
| `D³/(4·ann·x_new)` | `floor(floor(d²/(4·ann·x_new))·d)` | Same |
| Newton stop | First iterate with `|Δ| <= 1` | Result within one unit of the exact solution |
| Deposit mint | `floor(total_supply·(D₁−D₀)/D₀)` | Rounds in favour of the pool |
| Withdrawal payout | `floor(reserve·lp_amount/total_supply)` | Rounds in favour of the pool |
| Swap fee | `floor(amount·fee_precision_units/FEE_PRECISION)` | Rounds in favour of the pool |
| Swap output | `reserve_out − y` | Rounds in favour of the pool |

A swap input whose post-fee value floors to zero is rejected with
`InvalidAmount`. A withdrawal whose proportional payout floors to zero on both
sides is rejected with `InsufficientLiquidity`, preserving the LP balance.

## Numeric limits

- All invariant and fee arithmetic uses checked `i128` operations; overflow
  returns `MathOverflow` (9) rather than wrapping or panicking.
- Minimum reserves are one unit per token. Zero reserves return
  `ZeroInvariant` (10) from `compute_d`, and zero/negative amounts return
  `InvalidAmount` (3).
- The Newton iteration needs `ann·S·D` to fit in `i128`, so a balanced pool
  supports roughly `sqrt(i128::MAX / (4·A))` units per side (`≈ 6.5·10¹⁷` for
  `A = 100`). Inputs that would exceed an intermediate are rejected before any
  transfer.
- `compute_dynamic_fee` scales `|balance0 − balance1|` by `FEE_PRECISION`; a pool
  whose reserves are too large for that product returns `MathOverflow`.
- `amp_coeff` must be `1..=MAX_A`; out-of-range values return
  `InvalidAmpCoeff` (7).

## Network, ledger and version context

The pool's stored state is bound to the network it was created on and to a
context version. `get_pool_context()` returns
`{ network_id, contract, version }`, and `add_liquidity`, `remove_liquidity` and
`swap` require that value as `expected_context`. `get_reserves()` applies the
live-network check without needing a context.

Validation is the first thing each entry point does after initialization, before
any invariant math:

| Mismatch | Error |
|---|---|
| Live ledger network ≠ network the stored state is bound to | `WrongNetwork` (12) |
| Caller's `network_id` ≠ bound network | `WrongNetwork` (12) |
| Caller's `contract` ≠ this deployment | `WrongContract` (13) |
| Stored version > `CURRENT_POOL_VERSION` (code downgrade) | `WrongVersion` (14) |
| Caller's `version` ≠ stored version (e.g. before a `migrate`) | `WrongVersion` (14) |

A pool initialized before this binding exists has no stored network or version.
It adopts the live network and reports version `0`, so it keeps operating
unchanged. Admin `migrate()` persists the binding and sets the version to
`CURRENT_POOL_VERSION` = 1 without touching reserves, LP supply or balances; it
is idempotent and returns `WrongNetwork` rather than re-binding state that
already belongs to another network.

Because the context is validated before any state change, a caller whose
captured context went stale (for example because the admin migrated the pool)
can call `get_pool_context()` again and retry the same operation.

## Failure atomicity and retries

`add_liquidity`, `remove_liquidity` and `swap` validate arguments, compute the
invariant and check slippage **before** any state change. They then commit the
reserves, LP supply, LP balance and operation receipt, advance `StateSeq`, and
only afterwards move tokens. A failing transfer reverts the whole invocation,
so a failed call leaves:

- token balances unchanged;
- `Reserve0`/`Reserve1` unchanged;
- `TotalSupply` and the caller's `LpBalance` unchanged;
- `StateSeq` and the operation receipt unchanged.

The same call can therefore be retried once the cause is fixed (smaller amount,
looser-bound but valid minimum, corrected token, or a refreshed pool context).

### Operation checkpoints

Each successful mutation increments the instance key `StateSeq` and stores the
new value under `OperationSeq(operation_key)`. `get_pool_state()` returns
`{ reserve0, reserve1, total_supply, state_seq }` and `get_operation_state()`
returns `{ committed, state_seq }` for a given sender/kind/operation id. A pool
initialized before this counter existed reads it as zero, so upgrades are
backwards compatible.

The `*_checked` entry points add `expected_state_seq` to their arguments. The
planner checks it immediately after the `PoolContext` validation and before the
replay check:

| Outcome of the first attempt | Checked retry |
|---|---|
| Rejected (no commit) | sequence unchanged → the same id can be reused |
| Committed, response lost | sequence advanced → `StateChanged` (16) |
| Committed, retry with current sequence | `DuplicateOperation` (15) |

This makes a blind resubmit safe even when the client generates a fresh
operation id: without the checkpoint it would be indistinguishable from a new
intent and would apply the trade twice. `preview_*_checked` reports the same
condition as `FailureStage::StateChanged` with remediation `RefreshState`,
without mutating state.

## Related

- Error codes: `contracts/ERROR_CODES.md` (`stableswap — StableSwapError`)
- Tests: `contracts/stableswap/src/lib.rs` (`mod tests`)
