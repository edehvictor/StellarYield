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

`StableSwapError` includes initialization, invariant, amount, and slippage/fee validation errors.

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
