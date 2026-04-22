# Stablecoin Manager Contract

## Purpose

`stablecoin_manager` handles collateralized debt positions (CDPs) for minting and repaying sUSD against vault-share collateral with CR checks and interest accrual.

## Public API

- `initialize(admin, s_usd, collateral_token, vault_metrics, oracle, icr, mcr, interest_rate)`
- `mint_s_usd(from, collateral_amount, mint_amount)`
- `repay_s_usd(from, repay_amount, withdraw_collateral)`
- `liquidate(liquidator, user)`

## Events

- `mint` and liquidation/repayment lifecycle events.

## Errors

`Error` enum includes init/auth/ratio/collateral/no-position/price-staleness failures.

## Storage Model

- Instance: admin, token/oracle addresses, ICR/MCR, interest params, cumulative index.
- Persistent: per-user `CDP`.

## Local Test

```bash
cd contracts
cargo test -p stablecoin_manager
```

## Integration Notes

- Reads vault metrics via external contract calls (`total_assets`, `total_shares`).
- Reads price from oracle `get_price`.
