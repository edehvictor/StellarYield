# Portfolio valuation boundary validation

Portfolio valuation inputs may come from external price feeds, persisted
positions, or client refresh callbacks. Those fields are untrusted and must be
validated before they are aggregated or written into component state.

## Shared contract

`shared/types/portfolioValuation.ts` exports:

- `validatePositionValuationInput(input, index?)` validates one position and
  returns either `{ ok: true, value }` with a fresh normalized object or
  `{ ok: false, failure }` with a typed `PortfolioValuationInputFailure`.
- `validatePortfolioValuationInputs(input)` validates the whole array and
  stops at the first invalid field, reporting its name and array index.
- `computeValidatedPortfolioValuationSummary(input)` validates before it
  aggregates, so a malformed entry cannot produce a partially computed total.

Validation rules:

- `protocol` and `asset` must be non-empty strings.
- `deposited`, `shares`, and `apy` must be finite, non-negative numbers when present.
- `currentValue` must be a finite, non-negative number or `null`.
- `fetchedAt` must be an ISO-8601 timestamp or `null`.
- `isPriceUnavailable` must be a boolean when present.
- `priceStatus` must be `priced`, `unpriced`, or `zero`.

Input objects are never mutated. Unknown fields are ignored instead of being
copied into the normalized value.

## Server behavior

`PortfolioService.computeValidatedValuationSummary()` returns the typed result
described above. The existing `computeValuationSummary()` helper delegates to
it and throws `PortfolioValuationDataError` (HTTP 400, code
`PORTFOLIO_VALUATION_INVALID_DATA`) when data is malformed. No aggregate is
emitted from a partially valid list.

## Client behavior

`parseRefreshedPositions()` in `client/src/portfolio/portfolioValuation.ts`
validates refresh payloads before `PortfolioDashboard` calls `setPositions`.
Invalid data throws `PortfolioValuationError` with code
`INVALID_VALUATION_DATA`, which `describeValuationFailure()` maps to a stable
message. The last accepted positions remain in state and the retry control can
be used with corrected data.

## Regression coverage

Tests cover normal aggregation, each malformed-field class, non-mutation of
caller data, state preservation on failure, and safe retry after corrected
input in `shared/types/portfolioValuation.test.ts`,
`client/src/components/portfolio/PortfolioDashboard.valuation.test.tsx`, and
`server/src/__tests__/portfolioValuationBoundary.test.ts`.
