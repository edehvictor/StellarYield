# Transparency boundary-value calculations

This document describes the rounding, checked arithmetic, and boundary
handling applied to the transparency status surface (#1914).

## Scope

- Server: `GET /api/transparency/summary` in `server/src/routes/transparency.ts`
  and its helpers `roundToTwoDecimals`, `checkedAdd`, `checkedSum`,
  `computeDeflationaryRatio`, and `assertValidHistoryPoint`.
- Client: status normalization in
  `client/src/pages/transparency/transparencyServiceHealth.ts` and display
  formatting in `TransparencyDashboard.tsx`.

## Rounding rules

- History revenue and burned amounts are rounded **half-up to two decimal
  places** per day before any totals are computed.
- Totals are exact sums of the rounded daily values; no additional rounding
  is applied after summation.
- The deflationary ratio is `burned / emissions * 100`, rounded **half-up
  to two decimal places** after clamping, and saturated at **100%** when
  burned exceeds emissions.
- Relayer `successRate` is clamped to `[0, 100]` before comparison against
  the 50% failed threshold; it is never rounded for the threshold check.
- `failureCount` is floored to a non-negative integer. Fractional counts
  floor, so `0.9` failures count as zero failures only when the raw value
  was otherwise well-formed.

## Checked arithmetic and limits

- Every addition is checked for finiteness, non-negativity, and overflow
  beyond `Number.MAX_SAFE_INTEGER - 1`. A violation throws
  `TransparencyCalculationError` instead of returning `NaN`, `Infinity`,
  or a wrapped value.
- Zero emissions yield a ratio of `0`, never `NaN` or `Infinity`.
- Non-finite, negative, or above-maximum history values are rejected by
  `assertValidHistoryPoint` before the cache is written.
- Aggregation computes every derived value **before** replacing the cache.
  A failing aggregation therefore leaves the previous snapshot intact and
  the summary route falls back to that snapshot when one exists, so a
  validation or execution failure cannot corrupt balances or totals.
  Callers can safely retry; the next call re-attempts with fresh data.

## Client status normalization

- `mapRelayerStatus` treats non-finite `failureCount` or `successRate`,
  negative counts, and out-of-range rates as degraded or failed, never
  healthy. A valid all-clear payload (`failureCount 0`, `successRate 100`)
  remains healthy.
- `summarizeTransparencyHealth` sanitizes every subsystem value with
  `sanitizeSubsystemState`. Missing, empty, or unrecognized values become
  `"unknown"` (which degrades the overall status) instead of flowing
  through as unchecked values.
- Display formatters guard against non-finite values: revenue formats as
  `$0`, tokens as `0`, and the ratio as `0.00%`, with negatives clamped
  to zero and the ratio capped at 100%.

## Tests

- Server: `server/src/__tests__/transparency.test.ts` covers zero,
  minimum, maximum, and near-limit ratio calculations, overflow rejection,
  non-finite rejection, and bounded aggregation output.
- Client: `client/src/pages/transparency/transparencyServiceHealth.test.ts`
  covers relayer boundary values at 0/50/100 and NaN/Infinity/out-of-range
  inputs, subsystem sanitization, and idempotent safe retry.
