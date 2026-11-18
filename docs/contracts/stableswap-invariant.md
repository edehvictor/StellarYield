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

## Failure atomicity and retries

`add_liquidity`, `remove_liquidity` and `swap` validate arguments, compute the
invariant and check slippage **before** transferring tokens or writing reserves,
LP supply, or LP balances. Because the whole invocation reverts on a typed
error, a failed call leaves:

- token balances unchanged;
- `Reserve0`/`Reserve1` unchanged;
- `TotalSupply` and the caller's `LpBalance` unchanged.

The same call can therefore be retried once the cause is fixed (smaller amount,
looser-bound but valid minimum, or corrected token). There are no operation
identity receipts in this contract: retries are safe because the failed call
never partially applied.

## Related

- Error codes: `contracts/ERROR_CODES.md` (`stableswap — StableSwapError`)
- Tests: `contracts/stableswap/src/lib.rs` (`mod tests`)
