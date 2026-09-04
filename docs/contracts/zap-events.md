# Zap Contract Events

Indexer reference for events emitted by the `zap` contract during swap-and-deposit execution.

All amounts are `i128` stroops (7 decimal places for standard Stellar assets). Addresses are Soroban `Address` values (typically contract IDs or account strkeys).

## Event Summary

| Topic | When emitted | Payload |
|-------|--------------|---------|
| `zap_init` | Contract initialized | `(admin, dex_router)` |
| `zap_part` | Swap output below quote but above minimum (partial fill) | `(user, input_token, vault_token, amount_in, expected_out, actual_out)` |
| `zap_ref` | Unused input returned to user after swap | `(user, token, amount, reason)` |
| `zap_dep` | Successful deposit into vault completes | `(user, amount_in, deposit_amount, shares)` |

The yield vault emits `dep_for` with `(payer, beneficiary, amount, shares)` when `deposit_for` runs. Indexers should correlate `zap_dep.deposit_amount` with the vault `dep_for.amount` and `zap_dep.shares` with `dep_for.shares`.

## Emission Paths

### Full execution (direct deposit)

When `input_token == vault_token`, no swap occurs.

1. `zap_dep` — `(user, amount_in, deposit_amount, shares)` where `deposit_amount == amount_in`.

### Full execution (swap)

When swap output meets or exceeds the quoted `expected_amount_out` (or `expected_amount_out == 0` and output meets `min_amount_out`):

1. `zap_ref` — only if unused input remains on the zap contract after the router swap (`reason = unused_in`).
2. Vault `dep_for` — external to zap.
3. `zap_dep` — `(user, amount_in, deposit_amount, shares)`.

### Partial fill

When `allow_partial` is true, `expected_amount_out > 0`, and `min_amount_out <= actual_out < expected_amount_out`:

1. `zap_part` — `(user, input_token, vault_token, amount_in, expected_out, actual_out)`.
2. `zap_ref` — if unused input remains (`reason = unused_in`).
3. Vault `dep_for`.
4. `zap_dep`.

### Failure (no zap events)

If output is below `min_amount_out`, or below `expected_amount_out` when partial fills are disallowed, the transaction reverts with `SlippageExceeded`. No `zap_part`, `zap_ref`, or `zap_dep` events are emitted.

## Field Reference

### `zap_init`

| Field | Type | Description |
|-------|------|-------------|
| `admin` | Address | Admin authorized to update router configuration |
| `dex_router` | Address | DEX router used for swaps |

### `zap_part`

| Field | Type | Description |
|-------|------|-------------|
| `user` | Address | End user receiving vault shares |
| `input_token` | Address | Token swapped from |
| `vault_token` | Address | Token deposited into vault |
| `amount_in` | i128 | Total input committed to the route |
| `expected_out` | i128 | Quoted swap output (`expected_amount_out` argument) |
| `actual_out` | i128 | Vault token received from the router |

### `zap_ref`

| Field | Type | Description |
|-------|------|-------------|
| `user` | Address | Refund recipient |
| `token` | Address | Token refunded (typically `input_token`) |
| `amount` | i128 | Refunded amount |
| `reason` | Symbol | `unused_in` — input not consumed by the router |

### `zap_dep`

| Field | Type | Description |
|-------|------|-------------|
| `user` | Address | Beneficiary of vault shares |
| `amount_in` | i128 | Original input amount from the user |
| `deposit_amount` | i128 | Vault token amount deposited |
| `shares` | i128 | Vault shares minted to `user` |

## Ordering Guarantees

Within a single successful `zap_deposit` invocation, zap events appear in this order:

1. `zap_part` (partial fill only)
2. `zap_ref` (refund only, when balance remains)
3. `zap_dep` (always on success)

The vault `dep_for` event is emitted during the deposit step and appears between `zap_ref` (if any) and `zap_dep` when indexing all contract events chronologically.

## Reconstructing User Outcomes

1. Locate `zap_dep` for the transaction to get final shares and deposited amount.
2. If `zap_part` is present, record shortfall as `expected_out - actual_out`.
3. If `zap_ref` is present, add `amount` back to the user's input-token balance delta.
4. Cross-check shares against vault `dep_for` for the same ledger entry.
