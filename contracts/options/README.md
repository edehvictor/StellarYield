# Options Contract

## Purpose

`options` supports minting, exercising, and expiring collateralized call/put options with on-chain settlement.

## Public API

- `initialize(admin, oracle)`
- `mint(minter, option_type, underlying_asset, quote_asset, strike_price, expiration_time, collateral_amount)`
- `exercise(exerciser, option_id)`
- `expire(option_id)`
- `get_premium(spot, strike, time_to_expiry_years, iv)`

## Events

- `mint`
- `exercise`
- `expire`

## Errors

`OptionsError` covers initialization, authorization, invalid option state, expiry windows, and amount/price validation.

## Storage Model

- Instance: admin, oracle, option counter.
- Persistent: option records by id.

## Local Test

```bash
cd contracts
cargo test -p options
```

## Integration Notes

- Uses SAC token transfers for collateral and settlement legs.
- Oracle address is stored for pricing extensions.
