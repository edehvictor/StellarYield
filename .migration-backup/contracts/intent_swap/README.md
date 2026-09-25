# Intent Swap Contract

## Purpose

`intent_swap` executes intent-based swaps where users post trade intents and registered solvers fill them competitively.

## Public API (selected)

- `initialize(admin, min_stake, protocol_fee_bps, fee_recipient)`
- `create_intent(...)`
- `fill_intent(solver, intent_id, buy_amount, sell_amount)`
- `cancel_intent(owner, intent_id)`
- `expire_intent(intent_id)`
- solver admin/staking methods
- `set_protocol_fee(admin, fee_bps)`, `set_min_stake(admin, min_stake)`

## Events

Init, intent lifecycle, solver lifecycle, and fee update events.

## Errors

`SwapError` covers initialization, auth, solver registration/stake, intent lifecycle, and fee-bound checks.

## Storage Model

- Instance: admin/config/counters (`ProtocolFeeBps`, `MinStake`, `NextIntentId`, etc.).
- Persistent: intents, best solutions, solver registration/stake.

## Local Test

```bash
cd contracts
cargo test -p intent_swap
```

## Integration Notes

- Protocol fee is bounded in basis points and charged on buy-side output before user delivery.
