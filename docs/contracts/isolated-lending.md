# Isolated Lending — Configuration Fingerprints and Network Context

`contracts/isolated_lending` lets admins change market parameters at any time:
collateral factor, collateral price, close factor, reserve requirement, interest
rate, protocol fee, oracle address and oracle policy. A client that previews an
operation under one configuration must not have it executed under another.

The contract exposes an **immutable configuration snapshot** and its **SHA-256
fingerprint** (for configuration staleness), and an explicit **ledger context**
(for network and version binding). Every state-modifying entry point requires
both.

## Ledger context binding

`get_ledger_context() -> LedgerContext` returns the current network, deployment
and version context:

| Field | Meaning |
|---|---|
| `network_id` | SHA-256 of the network passphrase the pair state was initialised on |
| `contract` | Address of this pair deployment |
| `version` | Storage layout version (0 = legacy, 1 = current) |

Callers capture this alongside `get_config_fingerprint()` before constructing a
transaction and pass it as `expected_context` to every state-modifying call. The
contract validates:

1. `expected_context.network_id` equals the live network hash — rejects
   `WrongNetwork` if the call arrives on a different network.
2. `expected_context.contract` equals `env.current_contract_address()` — rejects
   `WrongContract` if the caller's snapshot named a different deployment.
3. `expected_context.version` equals the stored version — rejects `WrongVersion`
   if the layout has been migrated between snapshot and execution.

A legacy pair (version 0, initialised before this feature) has no stored binding
and skips the network/version checks. Run `migrate(admin)` to stamp the live
network and upgrade to version 1.

### Entry points that require a context

All state-modifying entry points now require `expected_context: LedgerContext`:
`supply`, `withdraw`, `post_collateral`, `repay`, `repay_for`,
`queue_withdrawal`, `borrow`, `withdraw_collateral`, and `liquidate`.

Read-only entry points do not require one.

## Configuration fingerprints

## Snapshot contents

`get_config_snapshot() -> ConfigSnapshot` returns the admin-controlled
configuration used by execution:

| Field | Meaning |
|---|---|
| `collateral_factor_bps` | Borrow/liquidation threshold |
| `reserve_bps` | Share of supply withheld from borrowing |
| `close_factor_bps` | Maximum share of debt one liquidation may repay |
| `collateral_price_bps` | Collateral price in debt-token units (10 000 = par) |
| `interest_rate_per_ledger` | Borrow interest, parts per billion of the index per ledger |
| `protocol_fee_bps` | Share of accrued interest owed to the protocol |
| `oracle` | Configured oracle address, if any |
| `oracle_policy_configured` | Whether an oracle policy is enforced |
| `oracle_min_confidence_bps` | Policy: minimum quote confidence |
| `oracle_max_age_ledgers` | Policy: maximum quote age |

Deliberately excluded:

- **Balances and totals** (`TotalSupplied`, `TotalDebt`, user supplies,
  collateral and debt) — these change with every operation and would make the
  fingerprint useless.
- **The oracle quote** (`OracleQuote`) — it carries its own freshness policy
  (`OracleQuoteStale`, `OracleQuoteMissing`, `OracleConfidenceTooLow`) and
  changes every ledger.

A snapshot is a value: two markets with the same configuration values produce
equal snapshots, and re-writing a field with the same value keeps the snapshot
(and therefore the fingerprint) unchanged.

## Fingerprint

```
fingerprint = SHA-256("stellaryield_il_config_v1" || XDR(ConfigSnapshot))
```

- The domain separator is versioned. Adding a field to the snapshot in a future
  release changes every fingerprint, so the domain string must be bumped to
  `..._v2` and the change documented.
- The encoding is canonical (`to_xdr`), so the same configuration always yields
  the same 32-byte value.
- Derivation is pure: `get_config_fingerprint()` reads storage and writes
  nothing.

## Client handshake

1. Read the preview (`get_health_factor`, `get_totals`,
   `get_available_liquidity`) together with `get_config_fingerprint()`.
   `HealthFactor.config_fingerprint` carries the fingerprint the components
   were computed under, so a preview can be bound to its execution.
2. Submit `borrow`, `withdraw_collateral` or `liquidate` with that fingerprint
   as the trailing argument.
3. If an admin changed configuration in between, the call fails with
   `StaleConfig` (15). Refresh the preview and fingerprint, then retry.

### Entry points that require a fingerprint

| Entry point | Why |
|---|---|
| `borrow(user, amount, expected_config_fingerprint)` | Collateral factor, reserve, interest accrual and oracle policy determine the borrow limit and cost |
| `withdraw_collateral(user, amount, expected_config_fingerprint)` | Collateral factor and accrual determine how much may leave |
| `liquidate(liquidator, borrower, liquidation_id, repay_amount, expected_config_fingerprint)` | Collateral factor, collateral price, close factor and accrual determine whether and how much may be seized |

Entry points that do **not** require one are bound by balances rather than
configuration and cannot be executed on terms the caller did not see:
`supply`, `withdraw`, `post_collateral`, `repay`, `repay_for`,
`queue_withdrawal`, `claim_protocol_fees`, `push_oracle_quote`, and the
admin setters.

## Failure and retry guarantees

- The fingerprint is validated immediately after initialization and **before
  `accrue()`, any token transfer and any state write**. A stale call therefore
  cannot advance the borrow index, add protocol fees or move funds.
- On `StaleConfig` the whole invocation reverts, so balances, positions, totals
  and already-consumed liquidation ids are unchanged.
- A retry with a refreshed fingerprint is a fresh operation. `liquidate` also
  requires a liquidation id that has not been consumed; the rejected attempt
  does not consume its id (see `rejected_settlement_does_not_consume_the_liquidation_id`).

## Events

Every successful configuration change publishes:

| Topic | Data | When |
|---|---|---|
| `("config",)` | `(admin, fingerprint)` | After `set_reserve_bps`, `set_collateral_factor`, `set_collateral_price`, `set_close_factor`, `set_interest_rate`, `set_protocol_fee_bps`, `set_oracle` and `set_oracle_policy` |

Indexers can treat the latest `config` event as the current fingerprint and
invalidate cached previews.

## Storage

| Key | Class | Notes |
|---|---|---|
| `CollateralFactorBps`, `ReserveBps`, `CloseFactorBps`, `CollateralPriceBps`, `InterestRatePerLedger`, `ProtocolFeeBps`, `Oracle`, `OraclePolicy` | instance | Configuration read by the snapshot |
| `BorrowIndex`, `LastAccrualLedger`, `ProtocolFees`, `TotalSupplied`, `TotalDebt` | instance | Market totals/accrual, not part of the snapshot |
| `Supply(user)`, `Collateral(user)`, `Debt(user)`, `DebtIndex(user)`, `PendingWithdrawal(user)`, `Liquidation(borrower, id)` | persistent | Per-user state |

No new storage key is introduced: the snapshot and fingerprint are derived from
existing configuration. See [storage-ttl-strategy.md](./storage-ttl-strategy.md).

## Breaking API changes

The trailing `expected_config_fingerprint: BytesN<32>` parameter is a breaking
change for `borrow`, `withdraw_collateral` and `liquidate`, and
`HealthFactor` gains a `config_fingerprint` field. Clients must update their
invocations and decode the new `HealthFactor` shape.

## Error codes

| Code | Name | Meaning |
|---|---|---|
| 4 | `InvalidConfig` | Invalid admin configuration value |
| 15 | `StaleConfig` | Fingerprint does not match the current configuration; refresh and retry |
| 16 | `WrongNetwork` | Context names a different network than the live ledger or stored binding |
| 17 | `WrongContract` | Context names a different deployment address |
| 18 | `WrongVersion` | Context storage version does not match the stored version |
| 19 | `InvalidOracleQuote` | Oracle quote has an invalid price, confidence or future ledger |

See `contracts/ERROR_CODES.md` for the full table.

## Rounding and numeric limits

All amounts are non-negative integer token units, so every division rounds
**down** unless noted.

| Calculation | Rule | Effect |
|---|---|---|
| Collateral value | `floor(collateral · price_bps / 10_000)` | A price below one bps of a unit values the collateral at zero |
| Borrow limit | `floor(collateral_value · collateral_factor_bps / 10_000)` | Borrowing at the limit is allowed; one unit more is rejected |
| Reserve requirement | `floor(total_supplied · reserve_bps / 10_000)` | One bp of a small pool reserves nothing |
| Index growth | `floor(index · rate · elapsed_ledgers / 10^9)` | No interest accrues within the same ledger |
| Accrued interest / debt | `floor(total_debt · growth / index)`, `floor(debt · index / debt_index)` | Rounds in favour of borrowers |
| Protocol fees | `floor(interest · fee_bps / 10_000)` | Rounds in favour of borrowers |
| Close-factor cap | `ceil(debt · close_factor_bps / 10_000)`, capped at `debt` | A 100% close factor can always clear a position |
| Seized collateral | `floor(repaid · 10_000 / price_bps)` | The liquidator never receives more value than it repaid |
| Available liquidity | `max(0, supplied − debt − pending − reserve)` | Never returns a negative number |

Every arithmetic step is checked. Amounts beyond `i128`, or a subtraction below
zero, return `MathOverflow`; zero or negative amounts return `InvalidAmount`; a
zero price, zero factor or out-of-range bps value returns `InvalidConfig`.
A one-unit position at a factor below 10 000 has a zero borrow limit, so the
smallest debt needs a 100% factor.

## Failure atomicity and retries

Operations compute every checked value and validate balances and limits
**before** transferring tokens or writing reserves, debt, supply, pending
withdrawals or a liquidation id. A typed error therefore leaves token balances,
positions, totals, the borrow index, accrual markers and the liquidation id
unchanged, so the same call can be retried with corrected inputs. Examples:
repay debt before borrowing another unit, withdraw no more than redeemable
cash, or refresh the configuration fingerprint after an admin change and retry.

Oracle quotes are checked both when pushed and when consumed. A quote must have
a nonzero price, confidence at most 10,000 bps, and a ledger no later than the
current ledger. A malformed stored quote fails with `InvalidOracleQuote` before
borrow accrual or transfers; the oracle can publish a corrected quote and the
borrow can be retried safely. The push entry point rejects invalid price or
confidence with `InvalidConfig` and leaves the previous quote intact.
