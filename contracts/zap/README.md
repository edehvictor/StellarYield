# Zap Contract

## Purpose

`zap` provides one-click swap-and-deposit into `yield_vault`. It accepts an input token, swaps through a configured DEX router, then deposits for the user.

## Public API

- `initialize(admin, dex_router)`
- `zap_deposit(user, input_token, vault_token, vault, amount_in, min_amount_out, min_shares_out)`
- `set_dex_router(admin, new_router)`

## Events

- `zap_init`
- `zap_dep`

## Errors

- `NotInitialized`
- `AlreadyInitialized`
- `ZeroAmount`
- `Unauthorized`
- `SlippageExceeded`
- `SwapFailed`

## Storage Model

- Instance keys: `Admin`, `DexRouter`, `Initialized`
- No persistent user storage in this contract.

## Local Test

```bash
cd contracts
cargo test -p zap
```

## Integration Notes

- Calls DEX router `swap(...)`
- Calls vault `deposit_for(...)`
