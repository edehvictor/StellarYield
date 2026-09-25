# Settlement Contract

## Purpose

`settlement` finalizes matched trades and routes settlement fees with emergency pause controls.

## Public API

- `initialize(admin, matching_engine, fee_recipient, fee_bps)`
- `settle_trade(...)`
- `set_matching_engine(admin, new_engine)`
- `set_fees(admin, recipient, fee_bps)`
- `emergency_pause(admin)`, `emergency_unpause(admin)`
- views: `is_paused`, `get_fees`, `is_trade_settled`

## Events

Initialization, fee updates, pause/unpause, and trade settlement events.

## Errors

`SettlementError` covers init/auth/paused-state/fee and settlement validation failures.

## Storage Model

- Instance storage for admin/config/fee settings and pause state.
- Persistent storage for settled trade identifiers.

## Local Test

```bash
cd contracts
cargo test -p settlement
```

## Integration Notes

- Intended to be called by matching/intent execution layers.
