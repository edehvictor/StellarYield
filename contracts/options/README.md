# Options Contract

## Purpose

`options` supports minting, exercising, and expiring collateralized call/put options with on-chain settlement.

## Public API

- `initialize(admin, oracle)`
- `mint(minter, option_type, underlying_asset, quote_asset, strike_price, opening_time, expiration_time, collateral_amount)`
- `exercise(exerciser, option_id, expected_config_fingerprint)` exercises all remaining collateral
- `exercise_partial(exerciser, option_id, amount, expected_config_fingerprint)` exercises part of the collateral
- `exercise_partial_checked(exerciser, option_id, amount, expected_exercised, expected_config_fingerprint)` retry-safe partial exercise (see Settlement Safety)
- `get_settlement_state(option_id)` settlement progress: status, exercised amount, remaining amount
- `get_config_snapshot()` / `get_config_fingerprint()` expose the configuration settlement is validated against
- `cancel(minter, option_id)` cancels an unexpired option and returns its unexercised collateral
- `expire(option_id)`
- `deposit(owner, asset, amount)` / `withdraw(owner, asset, amount)`
- `get_free_collateral(owner, asset)` / `get_reserved_collateral(owner, asset)`
- `get_premium(spot, strike, time_to_expiry_years, iv)`
- `set_oracle_max_age(max_age)` / `clear_oracle_max_age()` / `get_oracle_max_age()` (oracle guard, admin only to change)

## Events

Position lifecycle events are versioned. Each event uses the topics
`(kind, option_id, schema_version)` and an `OptionLifecycleEvent` payload
containing the position id, option type, minter, actor, underlying and quote
assets, collateral asset, strike, exercise window, collateral amount, amount
moved by this transition, cumulative exercised amount, remaining collateral,
and ledger timestamp.

- `create` — position minted and collateral escrowed
- `fill` — partial exercise consumed part of the remaining collateral
- `exercise` — position fully exercised
- `expire` — unexercised collateral returned after expiry
- `cancel` — unexercised collateral returned to the minter

`deposit` and `withdraw` continue to emit their existing collateral events.

Admin configuration changes (`migrate`, `set_oracle_max_age`,
`clear_oracle_max_age`) publish a `config` event with topics `(config,)` and
the payload `(admin, new_fingerprint)`, so clients can invalidate a cached
fingerprint immediately.

## Errors

`OptionsError` covers initialization, authorization, invalid option state, expiry windows, and amount/price validation. `InvalidStrike` rejects a zero or negative strike at mint; `MathOverflow` signals checked settlement arithmetic that cannot be represented in `i128` or a `u32` option id.
`OptionsError` covers initialization, authorization, invalid option state, expiry windows, amount/price validation, and `SettlementStateChanged` (22) for a retried checked settlement whose progress no longer matches.

## Configuration Fingerprint

Settlement executes under the contract configuration the caller observed.
`get_config_snapshot()` returns the admin-controlled configuration settlement
depends on — `admin`, `oracle`, `oracle_max_age` and the active
`storage_version` — and `get_config_fingerprint()` returns its SHA-256
fingerprint (domain-separated). The fingerprint is a pure function of those
values: it does not change when options are minted, exercised, cancelled or
expired, and it changes exactly when an admin changes the configuration.

Clients capture the fingerprint before preparing a settlement and pass it to
`exercise` / `exercise_partial`. The fingerprint is validated first, before the
position is read again and before any collateral moves; a mismatch (for example
after the admin enables the oracle guard or migrates storage) fails with
`StaleConfig`. A rejected settlement leaves balances, reserves, exercised
amounts and the position record untouched, so the caller can refresh the
fingerprint with `get_config_fingerprint()` and retry the same operation safely.

## Collateral Accounting

`get_premium` uses fixed-point arithmetic scaled by `1e9`. Its nonnegative
monetary divisions round down, so fractional base units are never included in
the returned premium. At or after expiry, intrinsic value is the exact positive
difference between spot and strike (or zero). Exercise settlement transfers
the requested collateral amount in token base units without further rounding.

Collateral held by the contract is tracked per `(owner, asset)` in two buckets:

- **Free**: deposited via `deposit`, withdrawable at any time with `withdraw`.
- **Reserved**: locked behind open option positions. It cannot be withdrawn.

`mint` backs the position with the minter's free collateral first and pulls only
the shortfall from their wallet (so minting without a deposit works as before).
The full `collateral_amount` is then reserved. The reserve is released as the
collateral leaves the contract: by `exercise` / `exercise_partial` (the exercised
amount), by `cancel` (the unexercised amount while the option is active), and by
`expire` (whatever was not exercised). `withdraw` can only take
free collateral, so it fails with `InsufficientFreeCollateral` rather than
undercollateralize an open position.

Positions minted before reserve tracking existed have no recorded reserve;
releasing their collateral saturates at zero. Their collateral was never in the
free bucket, so it was never withdrawable.

The minter can cancel an option through its expiration timestamp. Cancellation
returns only the collateral not already paid out by partial exercises and
releases the same amount from the reserved balance. After expiration, the
existing permissionless `expire` path handles the return.

## Boundary Handling

Settlement arithmetic is checked at zero, minimum, maximum and near-limit
values:

- The collateral still backing a position is computed with `checked_sub`. If a
  stored cumulative exercised amount exceeds the collateral, `exercise`,
  `exercise_partial`, `cancel` and `expire` fail with `MathOverflow` before any
  token transfer, reserve release or position update.
- The new cumulative exercised amount is computed with `checked_add` before the
  settlement transfer, so a near-`i128::MAX` total is rejected while the
  transaction is still side-effect free.
- `mint` computes the next `u32` option id with `checked_add` before escrowing
  collateral. At `u32::MAX` it fails with `MathOverflow`, consuming no funds and
  no id. A non-positive strike is rejected with `InvalidStrike` for the same
  reason.
- `get_premium` keeps its documented floor rounding; `i128::MIN`, zero and
  near-`i128::MAX` inputs are handled without wrapping.
- `get_option_collateral_health` is a view and cannot fail, so it clamps the
  remaining obligation to zero for inconsistent stored values instead of
  aborting.

Every rejection is atomic: balances, free and reserved collateral, exercised
amounts and position records remain unchanged, so a caller can refresh its
inputs or fingerprint and safely retry the same settlement.
## Settlement Safety

`exercise`, `exercise_partial`, `cancel`, and `expire` validate every input and
checked arithmetic result first, then commit state (exercised amount, reserve
release, `exercised`/`expired`/cancelled flags), and only then move tokens.
Soroban reverts a failed invocation as a whole, so if the token leg fails the
option, the reserve, and all balances are exactly as before the call and the
same call can simply be retried. Nothing is ever left half-settled.

Progress is persisted per option and readable with `get_settlement_state`, which
returns a `SettlementState { status, exercised_amount, remaining_amount }`.
`status` is one of `Open`, `PartiallyExercised`, `Exercised`, `Expired`, or
`Cancelled`.

A client that does not know whether a partial exercise landed (timeout, dropped
response) should not resubmit blindly: `exercise_partial` would pay out again.
Use `exercise_partial_checked(exerciser, option_id, amount, expected_exercised)`
with the `exercised_amount` observed before the first attempt. If that attempt
already landed, the retry fails with `SettlementStateChanged` and moves nothing;
read `get_settlement_state` and resume from the new `exercised_amount`.
`exercise_partial_checked` also validates the configuration fingerprint exactly
like `exercise_partial`, and the state check runs after it. `exercise_partial`
and `exercise` keep their existing behavior.

## Oracle Freshness Guard

Once the admin calls `set_oracle_max_age(max_age)`, `mint` consults the oracle
configured in `initialize` before taking or reserving any collateral. The oracle
must expose `get_price(asset) -> Option<(price, observed_at)>`. An observation is
required for the underlying asset and, when it differs, the collateral asset
(the quote asset for puts). `mint` fails with:

- `OracleObservationMissing` if the oracle has no observation for the asset,
- `InvalidPrice` if the price is not positive or `observed_at` is zero or in the future,
- `StaleOracleObservation` if the observation is older than `max_age` seconds.

A rejected mint moves no funds and consumes no option id. Until the guard is
enabled (or after `clear_oracle_max_age`), `mint` does not call the oracle, so
existing deployments behave exactly as before.

## Storage Model

- Instance: admin, oracle, option counter, oracle guard max age, storage version.
- Persistent: option records by id, free and reserved collateral per `(owner, asset)`, and the amount already paid out by partial exercises per option.
- The configuration fingerprint is derived on demand from the instance
  configuration; nothing is stored for it, so it cannot go out of sync.

## Local Test

```bash
cd contracts
cargo test -p options
```

## Integration Notes

- Uses SAC token transfers for collateral and settlement legs.
- Oracle address is stored for pricing extensions.
