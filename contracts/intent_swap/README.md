# Intent Swap Contract

## Purpose

`intent_swap` executes intent-based swaps where users post trade intents and registered solvers fill them competitively.

## Public API (selected)

- `initialize(admin, min_stake, protocol_fee_bps, fee_recipient)`
- `create_intent(owner, sell_token, buy_token, sell_amount, min_buy_amount, max_fee, expiry, partial_fill, nonce)`
- `fill_intent(solver, intent_id, buy_amount, sell_amount, solver_fee)`
- `cancel_intent(owner, intent_id)`
- `cancel_nonce(owner, nonce)`
- `expire_intent(intent_id)`
- solver admin/staking methods
- `set_protocol_fee(admin, fee_bps)`, `set_min_stake(admin, min_stake)`

## Events

Init, intent lifecycle, solver lifecycle, and fee update events.

- `("receipt", intent_id)` → `SettlementReceipt { intent_id, solver, input_amount, output_amount, protocol_fee, solver_fee, ledger, fill_index }`, published exactly once per successful fill. The transaction hash is not visible to contracts; RPC `getEvents` returns it as `txHash` with the event.
- `("nonce_cxl",)` → `(owner, nonce)` when a nonce is invalidated.

## Errors

`SwapError` covers initialization, auth, solver registration/stake, intent lifecycle, and fee-bound checks, plus `NonceUsed` (16) and `FeeCapExceeded` (17).

## Storage Model

- Instance: admin/config/counters (`ProtocolFeeBps`, `MinStake`, `NextIntentId`, etc.).
- Persistent: intents, best solutions, solver registration/stake, owner nonces (`Nonce(owner, nonce)` → `Bound(intent_id)` | `Cancelled`).

## Local Test

```bash
cd contracts
cargo test -p intent_swap
```

## Integration Notes

- Protocol fee is bounded in basis points and charged on buy-side output before user delivery.
- Protocol fee + solver fee must not exceed the owner-signed `max_fee` (pro-rated for partial fills); this is checked before any transfer.
- `fill_intent` is atomic: if any transfer leg fails, every prior leg, state write, and the receipt are reverted, and the escrow stays refundable through `cancel_intent`, `cancel_nonce`, or `expire_intent`.
