# StableSwap Contract

## Purpose

`stableswap` implements low-slippage swaps for correlated assets using an amplified invariant and dynamic fee model.

## Public API (selected)

- `initialize(admin, token0, token1, lp_token, amp_coeff, base_fee, fee_multiplier)`
- `add_liquidity(...)`
- `remove_liquidity(...)`
- `swap(...)`
- pool views and pricing helpers

## Events

Init, liquidity, and swap events (including fee output).

## Errors

`StableSwapError` includes initialization, invariant, amount, token, and slippage/fee validation errors:
- `AlreadyInitialized` (1): Pool already initialized.
- `NotInitialized` (2): Pool not yet initialized.
- `InvalidAmount` (3): Amount is zero/negative or negative slippage bound.
- `InsufficientLiquidity` (4): Insufficient pool reserves or LP liquidity.
- `InsufficientOutput` (5): Output fell below caller-specified minimum.
- `Unauthorized` (6): Caller is not admin.
- `InvalidAmpCoeff` (7): Amplification coefficient out of bounds (`1..=MAX_A`).
- `InvalidFee` (8): Base fee or total dynamic fee exceeds bounds (`FEE_PRECISION`).
- `MathOverflow` (9): Arithmetic overflow or solver convergence failure.
- `ZeroInvariant` (10): Invariant is zero or fails to increase on liquidity deposit.
- `InvalidToken` (11): Duplicate token pair, LP token used as pool asset, or unrecognized token in swap.

## Safety & Invariant Guarantees

- **Boundary Validation**: Untrusted fields (`token0`, `token1`, `lp_token`, `amp_coeff`, `base_fee`, `fee_multiplier`, amounts, and slippage bounds) are validated at contract entry points before state or balance mutation.
- **State & Balance Preservation**: Token transfers and storage mutations occur only after all validations, reserve math, and slippage checks succeed. When validation or execution fails, existing state, pool reserves, and user balances remain strictly untouched.
- **Safe Retry**: Because failures leave state and balances unmodified, callers may safely retry operations immediately with adjusted slippage bounds or valid parameters without risk of fund lockup or state corruption.
- **Solver Hardening**: Newton-Raphson solvers (`compute_d` and `compute_y`) validate bounds, guard against non-positive intermediate reserves and zero denominators, and explicitly fail with `MathOverflow` rather than returning unverified approximations on non-convergence.

## Storage Model

- Instance: admin, tokens, amp, reserves, fee parameters, LP accounting metadata.
- Persistent: LP/user position state where applicable.

## Local Test

```bash
cd contracts
cargo test -p stableswap
```

## Integration Notes

- Fee precision is `1e7` units (`FEE_PRECISION` in code).
