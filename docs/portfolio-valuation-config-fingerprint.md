# Portfolio valuation configuration fingerprints (#1862)

A portfolio valuation is only correct relative to the configuration that
produced it — concentration thresholds, supported asset classes, protocol →
strategy mapping, pricing source, network. If that configuration changes while a
valuation is in flight, or after a result was cached, the result describes a
configuration that no longer exists. This document describes how StellarYield
detects that and keeps existing state safe.

## The fingerprint

`shared/types/portfolioValuationConfig.ts` (re-exported to the client from
`client/src/portfolio/portfolioValuationConfig.ts`):

| Export | Purpose |
| --- | --- |
| `captureValuationConfig(config)` | Validates, deep-copies and deep-freezes the config and returns `{ config, fingerprint }` (itself frozen). Mutating the caller's object afterwards cannot change the snapshot. |
| `computeValuationConfigFingerprint(config)` | `pvcfg1:` + 16 hex chars. Deterministic 64-bit FNV-1a over canonical JSON (sorted keys, `undefined` members dropped, `-0` → `0`). |
| `valuationConfigMatches(a, b)` / `assertValuationConfigCurrent(expected, current)` | Compare fingerprints, snapshots or raw configs. The assert throws `ValuationConfigError` (`VALUATION_CONFIG_STALE`, retryable). |
| `runWithValuationConfig({ readConfig, run, onStale, maxAttempts })` | Captures a snapshot, runs side-effect-free work against it, re-reads the live config, and returns only if it still matches. `onStale: "reject"` (default) throws; `"refresh"` re-runs on the new config up to `maxAttempts` (default 3). |

Configs that cannot be fingerprinted reliably (NaN/Infinity, functions, class
instances, cycles, `undefined` array items) and malformed fingerprints raise
`VALUATION_CONFIG_INVALID` (not retryable).

The fingerprint is a change detector, not a security primitive. It never
contains raw configuration values, so it is safe to return in API responses and
logs. Bump the `pvcfg1:` prefix if the canonical form ever changes.

## Server: `PortfolioService`

- `getValuationConfig(env?)` — the configuration that drives valuation and
  concentration grading for this deployment (includes resolved
  `CONCENTRATION_*_SHARE` thresholds and `VALUATION_CONFIG_VERSION`).
- `getValuationConfigFingerprint(env?)` — fingerprint of the live config.
- `computeValuationSummary(positions, { config?, expectedConfigFingerprint? })`
  now returns `FingerprintedPortfolioValuationSummary`, which is the existing
  `PortfolioValuationSummary` plus a **`configFingerprint`** field (additive,
  non-breaking). When `expectedConfigFingerprint` is supplied and no longer
  matches, it throws `VALUATION_CONFIG_STALE` **before** computing anything.
  A passed snapshot's fingerprint is always re-derived from its config, so a
  hand-built snapshot cannot vouch for a different configuration.
- `isValuationSummaryCurrent(summary, env?)` — whether a cached summary may be
  reused or must be recomputed.

## Client: `PortfolioDashboard`

- New optional prop `valuationConfig`. Without it, behaviour is unchanged.
- `onRefresh` now receives `{ configFingerprint }` (extra argument; existing
  zero-argument callbacks keep working) so fetchers can bind server work to it.
- If `valuationConfig` changes while a refresh is in flight, the refreshed
  positions are **discarded**, the last confirmed positions and balances stay on
  screen, and the error banner shows the stable `VALUATION_CONFIG_STALE`
  message with a **Retry** button. Retry runs against the new config.
- If the config changes while idle, a `valuation-config-stale-notice` banner
  offers **Revalue**; balances remain visible until the new valuation commits.

## Error codes

| Code | Retryable | Meaning |
| --- | --- | --- |
| `VALUATION_CONFIG_STALE` | yes | Work was computed under a configuration that is no longer live. Nothing was committed; retry against the current configuration. |
| `VALUATION_CONFIG_INVALID` | no | The configuration or fingerprint is malformed. Surfaced on the client as `VALUATION_REFRESH_FAILED`. |

## Contributor checklist

When adding a setting that changes how positions are priced, aggregated or
graded, include it in `PortfolioService.getValuationConfig()` (or the client's
`valuationConfig`) so a change to it invalidates in-flight and cached results.
Commit valuation results only after `runWithValuationConfig` /
`assertValuationConfigCurrent` succeeds.

## Tests

- `client/src/portfolio/portfolioValuationConfig.test.ts`
- `client/src/components/portfolio/PortfolioDashboard.configFingerprint.test.tsx`
- `server/src/__tests__/portfolioValuationConfig.test.ts`
