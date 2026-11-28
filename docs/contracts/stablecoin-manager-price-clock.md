# Stablecoin Manager — Oracle Price Clock Policy

`contracts/stablecoin_manager` values a CDP's collateral from an oracle quote
`(price, observed_at)`. Before the quote is used, `observed_at` is checked
against the **ledger timestamp** (`env.ledger().timestamp()`, called `now`
below). The check lives in `src/clock.rs` and runs in `get_user_cr`, so it
covers every operation that values collateral.

## Why both directions are checked

Checking only the maximum age (`now > observed_at + 3600`) is not enough. A quote
stamped *after* `now` never looks old, so it would pass the age check and keep
valuing collateral for as long as its stamp stays ahead of the ledger. The
original check also computed `observed_at + 3600`, which overflows for a
timestamp near `u64::MAX`.

## Policy

| Constant | Value | Meaning |
|---|---|---|
| `MAX_PRICE_AGE_SECS` | `3600` | Oldest an observation may be |
| `MAX_PRICE_FUTURE_SKEW_SECS` | `0` | How far ahead of ledger time an observation may be stamped (no tolerance) |

An observation is accepted when

```
now - MAX_PRICE_AGE_SECS  <=  observed_at  <=  now + MAX_PRICE_FUTURE_SKEW_SECS
```

Both ends are **inclusive**.

## Boundary behaviour

| `observed_at` relative to `now` | Result |
|---|---|
| `now + 1` or later (any future time, including `u64::MAX`) | `PriceFromFuture` (10) |
| `now` (current) | accepted |
| `now - 3600` (exactly at the maximum age) | accepted |
| `now - 3601` or earlier | `PriceStale` (9) |
| oracle returns no quote | `PriceStale` (9) |

The future check runs first, so a future-dated quote is never reported as stale.
The function uses saturating arithmetic only; no timestamp can make it panic, and
a ledger time smaller than `MAX_PRICE_AGE_SECS` does not underflow.

## Error results

| Code | Name | When |
|---|---|---|
| 9 | `PriceStale` | The quote is older than `MAX_PRICE_AGE_SECS`, or missing |
| 10 | `PriceFromFuture` | The quote is stamped later than `now + MAX_PRICE_FUTURE_SKEW_SECS` |

Both errors are returned by `mint_s_usd`, `repay_s_usd` (when withdrawing
collateral against remaining debt) and `liquidate`.

## State on failure

The check happens before any collateral value is computed, and a failed call
returns an error, which rolls back the whole invocation. After
`PriceFromFuture` or `PriceStale`, token balances, the CDP, and the interest
index are exactly as they were before the call. The regression tests in
`src/test.rs` assert this for mint, collateral withdrawal and liquidation.

## Changing the policy

`MAX_PRICE_FUTURE_SKEW_SECS` is `0` on purpose: every second of tolerance is a
second a quote can be pre-dated. Raise it only if the oracle is known to run
ahead of the ledger, update the table above, and update
`clock_policy_constants_are_the_documented_values` in the tests.

## Tests

```bash
cd contracts
cargo test -p stablecoin_manager
```

- `src/clock.rs` — unit tests for the boundaries and extreme timestamps.
- `src/test.rs` — contract-level tests with a controllable oracle: future,
  current, exactly-at-max-age and stale quotes, and state preserved on failure.
