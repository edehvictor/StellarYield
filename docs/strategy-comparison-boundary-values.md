# Strategy comparison boundary-value calculations

This document describes the rounding, checked arithmetic, and boundary
handling applied to strategy comparison (#1922).

## Scope

- Client: `client/src/features/strategies/strategyComparisonMath.ts` (shared
  helpers), the comparison page `client/src/pages/strategy/StrategyComparison.tsx`,
  its export `strategyComparisonExport.ts`, and `strategySort.ts`.
- Server: `GET /api/yields` assumption parameters in
  `server/src/routes/yields.ts` (`parseAssumptionBps`).

## Rounding rules

- All displayed and exported numbers are rounded **half-up (away from zero)
  to two decimal places** once, at display/export time. Intermediate values
  are never rounded. `roundHalfUp(1.005) === 1.01`; `-0` is returned as `0`.
- APY is shown with two decimals (`8.675` → `8.68`, `-3.005` → `-3.01`).
- Fees are shown as percentages: `bps / 100`, two decimals (`125` → `1.25`).
- Liquidity uses three tiers: `$0.00`–`$999.99`, `$1.0K`–`$999.9K` (one
  decimal), `$1.00M` and up (two decimals). A value that rounds into the next
  tier is shown in that tier: `999.995` → `$1.0K`, `999,950` → `$1.00M`.

## Limits

| Value | Accepted range | Outside the range |
| --- | --- | --- |
| Management / performance fee | integer 0–10,000 bps | entry skipped |
| Fee drag (sum of both fees) | 0–20,000 bps, checked sum | entry skipped |
| Risk score | 0–100 | entry skipped |
| TVL, liquidity (USD) | 0–`Number.MAX_SAFE_INTEGER` | entry skipped |
| APY, total APY, reward APY | any finite number (negative allowed) | entry skipped |
| Capital efficiency | 0–100 % when present | entry skipped |
| `/api/yields` assumption bps | 0–10,000 | `400 INVALID_ASSUMPTION` |

Every check throws `StrategyComparisonCalculationError` instead of
returning `NaN`, `Infinity`, or a wrapped value. The page and the export
catch it per entry, so one bad entry never hides the others.

Sorting treats `null`, `NaN`, and `±Infinity` as missing: those strategies
always sort to the bottom, and a non-finite APY never wins a tie-break.

## Failure and retry

- A `/api/yields` payload that is not a list is treated as a failed fetch.
  The strategies already in state are left untouched and the retry state is
  shown; **Try Again** refetches and replaces them only on success.
- Validation never mutates its input; the export works on validated copies.
- `GET /api/yields` checks assumptions before reading yield data, so a
  rejected request computes and caches nothing. A failed read now answers one
  `500 YIELD_FETCH_FAILED` body with `recoverable: true` (it previously wrote a
  second response after the first, which threw `ERR_HTTP_HEADERS_SENT`). The
  next request is served normally.

## Tests

- `client/src/features/strategies/strategyComparisonMath.test.ts`
- `client/src/features/strategies/strategySort.test.ts` (boundary block)
- `client/src/pages/strategy/strategyComparisonExport.test.ts` (boundary block)
- `client/src/pages/strategy/StrategyComparison.test.tsx` (#1922 block)
- `server/src/__tests__/yieldsStrategyComparisonBoundaries.test.ts`
