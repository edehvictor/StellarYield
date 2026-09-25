# Yield Vault Contract

## Purpose

`yield_vault` is the core vault primitive for deposits, withdrawals, share accounting, strategy rebalancing, referral rewards, and flash loans.

## Public API (selected)

- `initialize(admin, token)`
- `deposit(from, amount, min_shares_out)`
- `deposit_for(payer, beneficiary, amount, min_shares_out)`
- `withdraw(to, shares)`
- `rebalance(caller, strategy, amount, min_amount_out)`
- `harvest(caller, min_amount_out)`
- `emergency_pause(admin)`, `emergency_unpause(admin)`
- `set_admin(...)`, keeper/oracle/referral configuration methods

## Events

Includes init/deposit/withdraw/rebalance/harvest/pause/unpause/fee and referral events.

## Errors

Contract uses `VaultError` codes for initialization, authorization, pause-state, slippage, accounting, and referral failures.

## Storage Model

- Instance keys for core config and aggregate accounting (`Admin`, `Token`, `TotalAssets`, `TotalShares`, pause/config flags).
- Instance fee/referral keys.
- Persistent keys for user share balances and referral mapping/state.

## Local Test

```bash
cd contracts
cargo test -p yield_vault
```

## Integration Notes

- Consumed by `zap` for `deposit_for`.
- Integrates with strategy/oracle/keeper contracts.
