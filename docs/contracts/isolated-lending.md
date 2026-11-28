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

## Operation identity and safe retries

A wallet that times out waiting for a transaction cannot tell whether it
landed. Re-submitting a plain `supply`, `withdraw`, `post_collateral`,
`borrow`, `withdraw_collateral`, `repay`, `repay_for` or `queue_withdrawal`
applies the effect again, because each call is an independent operation. The
contract therefore offers an **idempotent variant** of each of these entry
points that takes a caller-chosen `operation_id: BytesN<32>` (#1754).

| Plain entry point | Idempotent variant | Receipt `kind` |
|---|---|---|
| `supply(user, amount, ctx)` | `supply_with_id(user, amount, ctx, operation_id)` | `supply` |
| `withdraw(user, amount, ctx)` | `withdraw_with_id(user, amount, ctx, operation_id)` | `withdraw` |
| `post_collateral(user, amount, ctx)` | `post_collateral_with_id(user, amount, ctx, operation_id)` | `post_col` |
| `borrow(user, amount, ctx, fp)` | `borrow_with_id(user, amount, ctx, fp, operation_id)` | `borrow` |
| `withdraw_collateral(user, amount, ctx, fp)` | `withdraw_collateral_with_id(user, amount, ctx, fp, operation_id)` | `wd_col` |
| `repay(user, amount, ctx)` | `repay_with_id(user, amount, ctx, operation_id)` | `repay` |
| `repay_for(payer, borrower, amount, ctx)` | `repay_for_with_id(payer, borrower, amount, ctx, operation_id)` | `repay_for` |
| `queue_withdrawal(user, amount, ctx)` | `queue_withdrawal_with_id(user, amount, ctx, operation_id)` | `queue_wd` |

Each variant returns an `OperationReceipt`:

| Field | Meaning |
|---|---|
| `operation_id` | The id the operation was applied under |
| `kind` | Operation kind (table above) |
| `account` | Account that authorized the call and scopes the id (`payer` for `repay_for_with_id`) |
| `beneficiary` | Account whose position changed (the borrower for `repay_for_with_id`, otherwise `account`) |
| `amount` | Requested amount |
| `ledger` | Ledger sequence at which the effect was applied |

`get_operation(account, operation_id) -> Option<OperationReceipt>` reads a
receipt without changing anything.

`ctx` is the `LedgerContext` from `get_ledger_context()`, exactly as for the
plain entry points. It is validated **before** the receipt lookup: a
submission with the wrong network, contract or version is rejected
(`WrongNetwork` / `WrongContract` / `WrongVersion`) even if its id was already
applied, and it does not consume a fresh id.

### Identity rules

- **Scope.** An id is scoped to the pair contract and to the authorizing
  account: storage key `Operation(account, operation_id)`. Two accounts can use
  the same id independently, and no account can consume, replay or block
  another account's id.
- **Authorization.** `operation_id` is an argument of the authorized call, so a
  relayer or front-end cannot change it after the user signed.
- **Generation.** Generate 32 random bytes (or a hash of a client-side
  request id) once per *logical* operation and keep it with the pending
  request until the outcome is known. Do not derive ids from timestamps or
  counters that can repeat. The all-zero id is reserved and rejected with
  `InvalidOperationId` (20).
- **One id, one request.** An id identifies a single request: its kind,
  beneficiary and amount. The configuration fingerprint passed to
  `borrow_with_id` and `withdraw_collateral_with_id` is a precondition, not part
  of the identity.

### What happens on each submission

| Situation | Result | State change |
|---|---|---|
| First successful submission | Effect applied, receipt stored, `("op",)` emitted, receipt returned | Yes, once |
| Same id, same kind, beneficiary and amount (a duplicate or safe retry) | The stored receipt is returned unchanged; `("op_replay",)` emitted | **None**: no token transfer, no interest accrual, no storage write |
| Same id, different kind, beneficiary or amount | `OperationConflict` (21) | None |
| Submission fails (any typed error, e.g. `InsufficientCollateral`, `StaleConfig`, `InsufficientLiquidity`) | Error returned, **id not consumed** | None |
| All-zero id | `InvalidOperationId` (20) | None |
| Wrong ledger context | `WrongNetwork` / `WrongContract` / `WrongVersion` | None; id not consumed |

A replay returns the original receipt even when re-executing the request now
would fail (for example a withdrawal after the market's cash has been
borrowed) or when configuration has changed since it was applied. A
duplicate can therefore never double-credit or double-debit an account.

### Atomicity

The idempotent variants validate the amount, initialization and id, then look
up the receipt, and only then run the same code as the plain entry point. That
code computes and validates every value before it moves tokens or writes
state. The receipt is written **after** the operation succeeded, never before.
In addition, Soroban reverts every storage write and token transfer of an
invocation that returns an error (covered by the regression tests), so a
receipt can never exist for an effect that was not applied, and a failed
attempt leaves balances, positions, totals, the borrow index, accrual markers
and the id itself unchanged.

### How to retry safely

1. Generate `operation_id` and submit the `*_with_id` call.
2. If the outcome is unknown (timeout, dropped connection), either call
   `get_operation(account, operation_id)` or simply re-submit **the same
   request with the same id**. Both are safe.
3. On a typed error the id is still free: fix the input (or refresh the
   configuration fingerprint) and retry with the same id, or use a new one.
4. Use a **new** id for every new logical operation, including a second
   deposit of the same amount.

Liquidations already carry an identity: `liquidate` takes a `liquidation_id`
that is consumed only by a successful liquidation and rejects a reused id with
`AlreadyLiquidated` (11). It is unchanged.

### Events

| Topic | Data | When |
|---|---|---|
| `("op",)` | `(account, kind, operation_id, beneficiary, amount)` | First successful application of an idempotent operation |
| `("op_replay",)` | `(account, kind, operation_id)` | A duplicate submission returned an existing receipt |

### Storage

`Operation(account, operation_id)` is a persistent key holding the
`OperationReceipt`. Its TTL is extended to ~30 days (518 400 ledgers) when it is
written, so a delayed retry is still recognised. An id whose receipt has
expired is treated as unused; clients must not retry a request older than that
window with the same id.

### Compatibility

This is an **additive** change. The plain entry points keep their signatures
and semantics (every call applies its effect and consumes no id), so existing
callers are unaffected. `IsolatedLendingError` gains codes 20 and 21,
`PairDataKey` gains `Operation`, and the contract exports the new
`OperationReceipt` type. Clients that need retry safety should move to the
`*_with_id` variants.
