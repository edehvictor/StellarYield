# Transparency boundary-value calculations and external data hardening

This document describes the rounding, checked arithmetic, boundary
handling, and malformed external data validation applied to the
transparency status surface (#1913, #1914).

## Scope

- Server: `GET /api/transparency/summary` and `/api/transparency/failover-history`
  in `server/src/routes/transparency.ts` and helpers `roundToTwoDecimals`,
  `checkedAdd`, `checkedSum`, `computeDeflationaryRatio`,
  `assertValidHistoryPoint`, `validateExternalHistory`, and
  `buildTransparencySummary`.
- Client: boundary validation and status normalization in
  `client/src/pages/transparency/transparencyServiceHealth.ts`,
  `client/src/pages/transparency/smokeResults.ts`, and display/retry
  handling in `TransparencyDashboard.tsx`.

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

## Malformed external data validation (#1913)

- **Server boundary validation**:
  - `assertValidHistoryPoint`, `validateExternalHistory`, and
    `buildTransparencySummary` validate untrusted external inputs before any
    state or cache mutation. History points require a valid `YYYY-MM-DD`
    calendar date and finite non-negative `revenue` and `burned` numbers
    within `MAX_TRANSPARENCY_VALUE`.
  - Malformed external data throws a typed `TransparencyValidationError`
    (subclass of `TransparencyCalculationError`) carrying a machine-readable
    `code` (`MALFORMED_EXTERNAL_DATA`, `MALFORMED_HISTORY_POINT`,
    `INVALID_QUERY_PARAMETER`, or `MALFORMED_INCIDENT_PAYLOAD`).
  - Cached snapshots are defensively cloned on write and read, and the cache
    is replaced only after full validation and aggregation succeed. When a
    valid snapshot is already cached, a failed refresh preserves existing
    state and balances. When no cached snapshot exists, `GET /api/transparency/summary`
    returns HTTP 500 with `{ error, code }` and recovers on the next valid retry.
- **Client boundary validation**:
  - `validateTransparencySummaryPayload` validates `/api/transparency/summary`
    responses at the boundary and throws `TransparencyExternalDataError`
    (`code: "MALFORMED_SUMMARY_PAYLOAD" | "MALFORMED_HISTORY_ENTRY"`) without
    mutating dashboard state. If a valid snapshot is already displayed, a
    failed refresh preserves existing balances and chart history; on an
    initial load failure, **Try Again** retries and renders once valid data
    arrives.
  - `validateFailoverIncidentsPayload` and `validateFailoverIncident`
    validate `/api/transparency/failover-history` envelopes and entry fields
    (`id`, `protocolId`, `protocolName`, `trigger`, `startedAt`, `resolved`,
    `reasons`, optional `recoveredAt` and `durationMs`).
  - `parseIndexerStatusPayload` and `parseRelayerStatusPayload` validate
    `/api/indexer/status` and `/api/relayer/status` independently so a
    malformed response from one endpoint never discards a valid status from
    the other, and missing or non-boolean relayer fields never default to
    `"healthy"`.
  - `assessRegistryFromRecords` ignores metadata keys prefixed with `_` (such
    as `_comment`) and degrades to `"unknown"` when network records or
    contract addresses are malformed.
  - `parseSmokeRunResult` and `parseSmokeHistory` validate check items and
    timestamps from `localStorage` before updating smoke-test health.

## Tests

- Server: `server/src/__tests__/transparency.test.ts` covers zero,
  minimum, maximum, and near-limit ratio calculations, overflow rejection,
  non-finite rejection, malformed external data rejection, preservation of
  cached balances, and safe retry recovery.
- Client: `client/src/pages/transparency/transparencyServiceHealth.test.ts`,
  `client/src/pages/transparency/smokeResults.test.ts`, and
  `client/src/pages/transparency/TransparencyDashboard.test.tsx` cover
  relayer boundary values, malformed summary/incident/health/smoke payloads,
  preservation of existing balances on failed refresh, and idempotent retry.
