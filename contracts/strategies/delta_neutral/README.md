# Delta Neutral Strategy Contract

## Purpose

`delta_neutral` manages paired long-spot and short-perp positions with rebalance controls to maintain market-neutral exposure.

## Public API (selected)

- `initialize(admin, usdc_token, spot_token, amm_router, perp_exchange, oracle)`
- `open_position(user, amount, min_spot_out)`
- `close_position(user)`
- `collect_funding(user)`
- `auto_rebalance(caller, user)`
- `pause(admin)`, `unpause(admin)`
- `set_rebalance_threshold(admin, bps)`

## Events

Initialization, position open/close, funding, rebalance, and pause/unpause events.

## Errors

`StrategyError` includes init/auth/position-state/paused-state/threshold validation.

## Storage Model

- Instance: admin, integration addresses, initialized/paused flags, global config/counters.
- Persistent: per-user `Position`.

## Local Test

```bash
cd contracts
cargo test -p delta_neutral
```

## Integration Notes

- Calls AMM router, perp exchange, and oracle contracts.
