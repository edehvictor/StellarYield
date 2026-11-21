# Zap Contract

## Purpose

`zap` provides one-click swap-and-deposit into `yield_vault`. It accepts an input token, swaps through a configured DEX router, then deposits for the user.

## Public API

- `initialize(admin, dex_router)`
- `zap_deposit(user, input_token, vault_token, vault, amount_in, min_amount_out, min_shares_out, expected_amount_out, allow_partial, op_id)`
- `zap_deposit_with_deadline(user, input_token, vault_token, vault, amount_in, min_amount_out, min_shares_out, options: ZapOptions, deadline)`
- `get_op_status(user, op_id) -> Option<ZapStatus>`
- `set_dex_router(admin, new_router)`

`min_amount_out` is inclusive: output equal to the minimum is accepted.
During a swap, the router may transfer only exactly `amount_in` of
`input_token` from the zap contract to the configured router address. It must
return any unused input to the zap; a larger transfer or alternate recipient
fails with `SwapFailed`.

## Partial completion and retry safety

Both `zap_deposit` and `zap_deposit_with_deadline` accept an `op_id: u64` caller-chosen identifier. The contract uses it to prevent double-execution and support safe retry.

`ZapOptions` groups `expected_amount_out`, `allow_partial`, and `op_id` for the
deadline-bound entry point.

| Status | Meaning | Client action |
|--------|---------|---------------|
| (absent) | Never started | Submit normally |
| `Pending` | Input transferred, swap or deposit incomplete | Retry with the same `op_id` |
| `Settled` | Successfully completed | Do not retry; start fresh with a new `op_id` |

**Retry behaviour:** When an op_id is `Pending`, the retry call skips the input transfer and uses any `vault_token` already held by the contract from a prior swap. Any leftover input is refunded before the deposit is attempted.

**Atomicity guarantees:** Soroban rolls back token transfers, events, and status updates when an invocation fails. A failed first attempt therefore leaves the operation absent; a failed retry preserves its prior `Pending` status. A `Settled` op_id is never re-executed; a second attempt with the same `op_id` returns `OpAlreadySettled` (error code 7) before any token moves.

## Events

- `zap_init` — `(admin, dex_router)`
- `zap_part` — partial fill when swap output is below quote but above minimum
- `zap_ref` — unused input refunded to user after swap
- `zap_dep` — successful execution and vault deposit

See [Zap event reference](../../docs/contracts/zap-events.md) for indexer field schemas and ordering guarantees.

## Errors

| Code | Name | Meaning |
|------|------|---------|
| 1 | `NotInitialized` | Contract not yet initialized |
| 2 | `AlreadyInitialized` | `initialize` already called |
| 3 | `ZeroAmount` | `amount_in` is zero or negative |
| 4 | `Unauthorized` | Caller is not the admin |
| 5 | `SlippageExceeded` | Swap output below the inclusive `min_amount_out` boundary or below quote when partial fill is disallowed |
| 6 | `SwapFailed` | Router call or dry-run failed, returned invalid output, or requested an input-token transfer outside the authorized amount or recipient |
| 7 | `OpAlreadySettled` | `op_id` was already successfully completed; use a new op_id |
| 4001 | `QuoteExpired` | Ledger timestamp is past `deadline` |

## Storage Model

- Instance keys: `Admin`, `DexRouter`, `Initialized`
- Temporary keys: `OpStatus(user, op_id)` — TTL 1000 ledgers; records `Pending` or `Settled` per operation.
- No persistent user storage in this contract.

## Local Test

```bash
cd contracts
cargo test -p zap
```

## Integration Notes

- Calls DEX router `swap(...)`
- Calls vault `deposit_for(...)`
- Clients should choose a unique `op_id` per operation (e.g., a nonce or timestamp). After a failed or unconfirmed transaction, check `get_op_status(user, op_id)` before deciding to retry or start fresh.
