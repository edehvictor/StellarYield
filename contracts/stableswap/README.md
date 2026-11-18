# StableSwap Contract

## Purpose

`stableswap` implements low-slippage swaps for correlated assets using an amplified invariant and dynamic fee model.

## Public API (selected)

- `initialize(admin, token0, token1, lp_token, amp_coeff, base_fee, fee_multiplier)`
- `add_liquidity(...)`
- `remove_liquidity(...)`
- `swap(...)`
- pool views and pricing helpers

- `preview_swap(token_in, amount_in, min_out) -> Diagnostic` (read-only dry run)
- `preview_add_liquidity(amount0, amount1, min_mint_amount) -> Diagnostic` (read-only dry run)

## Diagnostics

`add_liquidity` and `swap` validate and compute everything **before** any token
transfer or storage write. A failed call therefore leaves reserves, LP supply,
LP balances and token balances unchanged, and can be retried with corrected
arguments.

The `preview_*` calls run the same validation without mutating state and return:

```text
Diagnostic { ok: bool, stage: FailureStage, error_code: u32, remediation: RemediationPath }
```

| `FailureStage`    | Meaning                                   |
| ----------------- | ----------------------------------------- |
| `None`            | No failure                                |
| `PoolState`       | Not initialized / no usable liquidity     |
| `InputValidation` | Bad amount or unknown token               |
| `FeeComputation`  | Dynamic fee computation failed            |
| `Invariant`       | D / y solving failed or overflowed        |
| `Slippage`        | Result below the caller's minimum         |

| `RemediationPath` | Suggested action                          |
| ----------------- | ----------------------------------------- |
| `None`            | Nothing to do                             |
| `InitializePool`  | Initialize the pool first                 |
| `FixInput`        | Correct arguments and retry               |
| `AddLiquidity`    | Add liquidity or use a smaller size       |
| `ReduceAmount`    | Reduce the amount and retry               |
| `RelaxSlippage`   | Loosen `min_out` / `min_mint_amount`      |
| `ContactAdmin`    | Not caller-fixable                        |

Diagnostics are privacy-safe: they contain only these enums and the numeric
`StableSwapError` code — never addresses, amounts, reserves or balances.

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
