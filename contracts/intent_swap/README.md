# Intent Swap Contract

## Purpose

`intent_swap` executes intent-based swaps where users post trade intents and registered solvers fill them competitively.

## Public API (selected)

- `initialize(admin, min_stake, protocol_fee_bps, fee_recipient)`
- `create_intent(owner, sell_token, buy_token, sell_amount, min_buy_amount, max_fee, expiry, partial_fill, nonce, domain)`
- `fill_intent(solver, intent_id, buy_amount, sell_amount, solver_fee, quoted_at)`
- `get_domain()` → `IntentDomain { network_id, verifying_contract }`
- `get_version()` → `u32` (domain separation contract version)
- `create_signature_payload(contract_version, domain, operation_type, nonce)` → `IntentSignaturePayload`
- `compute_signature_payload_hash(payload)` → `BytesN<32>` (canonical SHA-256 payload hash)
- `set_max_quote_age(admin, max_age_secs)`, `get_max_quote_age()`
- `cancel_intent(owner, intent_id)`
- `cancel_nonce(owner, nonce)`
- `expire_intent(intent_id)`
- solver admin/staking methods
- `set_protocol_fee(admin, fee_bps)`, `set_min_stake(admin, min_stake)`

## Events

Init, intent lifecycle, solver lifecycle, and fee update events.

- `("receipt", intent_id)` → `SettlementReceipt { intent_id, solver, input_amount, output_amount, protocol_fee, solver_fee, ledger, fill_index }`, published exactly once per successful fill. The transaction hash is not visible to contracts; RPC `getEvents` returns it as `txHash` with the event.
- `("nonce_cxl",)` → `(owner, nonce)` when a nonce is invalidated.
- `("quote_age",)` → `(max_age_secs,)` when the quote window changes.

## Errors

`SwapError` covers initialization, auth, solver registration/stake, intent lifecycle, and fee-bound checks, plus `NonceUsed` (16), `FeeCapExceeded` (17), `DomainMismatch` (18), `QuoteExpired` (19) and `QuoteFromFuture` (20).

## Storage Model

- Instance: admin/config/counters (`ProtocolFeeBps`, `MinStake`, `MaxQuoteAge`, `NextIntentId`, etc.).
- Persistent: intents, best solutions, solver registration/stake, owner nonces (`Nonce(owner, nonce)` → `Bound(intent_id)` | `Cancelled`).

## Local Test

```bash
cd contracts
cargo test -p intent_swap
```

## Integration Notes

- Protocol fee is bounded in basis points and charged on buy-side output before user delivery.
- Protocol fee + solver fee must not exceed the owner-signed `max_fee` (pro-rated for partial fills); this is checked before any transfer.
- `min_buy_amount` binds the owner's net output after all fees, summed over every fill: after each fill the owner has received at least `ceil(min_buy_amount × filled_sell / sell_amount)`, and exactly `min_buy_amount` or more once fully filled.
- `domain` must equal `get_domain()`: `network_id` is SHA-256 of the network passphrase and `verifying_contract` is this deployment, so a signed intent cannot be replayed on another network or deployment.
- A solver quote is settleable while `quoted_at <= ledger timestamp <= quoted_at + max_quote_age` (default 30 s); older quotes fail with `QuoteExpired`, future-dated ones with `QuoteFromFuture`.
- `fill_intent` is atomic: if any transfer leg fails, every prior leg, state write, and the receipt are reverted, and the escrow stays refundable through `cancel_intent`, `cancel_nonce`, or `expire_intent`.
