# Portfolio Builder Dust Validation (#1378)

A portfolio split across several vaults can leave a position that is too small
to deposit, or that rounds to zero once integer distribution runs. Those
deposits waste fees and can be rejected on-chain, so the builder blocks them
before any signature is requested.

## Rules

`shared/types/portfolioDust.ts` is the single source of truth for both the
client and the server:

- A non-zero weight below **0.01%** is `WEIGHT_BELOW_MINIMUM`.
- A distributed amount of **0** is `AMOUNT_ROUNDS_TO_ZERO`.
- A positive distributed amount below the minimum deposit (default `1` base
  unit, configurable) is `AMOUNT_BELOW_MINIMUM`.
- Intentionally zero-weight vaults are ignored.
- An empty total or empty allocation list is a valid empty state with an
  explanatory message, not an error.

Amounts are distributed with the same integer math as the builder: floor each
weight share, then give the remainder to the largest position. `valid` is
`false` only when at least one issue exists.

The UI (`DustAllocationWarning`) lists each flagged vault, shows the thresholds
and affected-vault count, and offers **Remove dust & rebalance**, which drops
the flagged vaults and redistributes their weight to the remaining positions.
Execution stays disabled until the draft is clean.

## API

`POST /api/portfolio/builder/validate`

```json
{
  "totalAmount": "1",
  "minimumAllocationAmount": "1",
  "allocations": [
    { "vaultContractId": "blend", "vaultName": "Blend", "weight": 50 },
    { "vaultContractId": "soroswap", "vaultName": "Soroswap", "weight": 50 }
  ]
}
```

`200 OK` — well-formed input, with dust issues:

```json
{
  "valid": false,
  "message": "1 allocation would receive dust at this total; adjust or redistribute before depositing.",
  "totalAmount": "1",
  "minimumAllocationAmount": "1",
  "minNonZeroWeightPct": 0.01,
  "weightsTotalPct": 100,
  "issues": [
    {
      "code": "AMOUNT_ROUNDS_TO_ZERO",
      "vaultContractId": "soroswap",
      "vaultName": "Soroswap",
      "index": 1,
      "weightPct": 50,
      "amount": "0",
      "minimumAmount": "1",
      "message": "Allocation of 50% rounds to zero at the current total amount.",
      "remediation": "Increase the total amount or move this allocation into a larger vault position."
    }
  ],
  "suggestedAllocations": [{ "vaultContractId": "blend", "weight": 100 }]
}
```

Malformed payloads return a typed `400`:

- `INVALID_BODY` — body is not an object.
- `INVALID_TOTAL_AMOUNT` — total is not a non-negative integer amount.
- `INVALID_ALLOCATIONS` / `INVALID_ALLOCATION` — missing/invalid entries.
- `INVALID_ALLOCATION_WEIGHT` — weight outside 0–100.
- `ALLOCATION_SUM_MISMATCH` — weights do not sum to 100% (tolerance 0.01).

## Verification

- `shared/types/portfolioDust.test.ts` — clean, rounds-to-zero, weight dust,
  minimum amount, empty states, exact distribution, typed input errors.
- `client/src/features/portfolio_builder/DustAllocationWarning.test.tsx` —
  empty render, issue list, cleanup loading state.
- `client/src/features/portfolio_builder/PortfolioBuilder.test.tsx` — execution
  is blocked for dust and enabled after rebalancing.
- `server/src/__tests__/portfolioBuilderValidation.test.ts` — 200 dust results,
  empty state, and typed 400 responses.
