# Exposure Concentration Warnings

A portfolio spread across many positions can still be dangerously concentrated in a
single asset or a single protocol. Three positions across three protocols look
diversified in a pie chart even when one of them holds 80% of the value. These
warnings surface that so users do not read a chart as diversification it does not have.

## Where the calculation lives

`shared/types/exposureConcentration.ts` holds the whole model, so the server and the
client grade exposure identically instead of each re-deriving it:

| Export | Purpose |
| --- | --- |
| `analyzeConcentration(input, thresholds?)` | Grades asset and protocol buckets, returns entries, warnings, top shares, and worst severity |
| `buildExposureBuckets(positions, select)` | Aggregates a position list into `byAsset` / `byProtocol` / `totalValueUsd` |
| `resolveConcentrationThresholds(input?)` | Merges partial overrides onto the defaults, validating each value |
| `DEFAULT_CONCENTRATION_THRESHOLDS` | The shipped defaults |

## Severity

Each bucket's share of the total is graded against two cutoffs per dimension:

- `ok` — at or below the warn threshold
- `warning` — above `warn`
- `critical` — above `critical`

Comparisons are strictly greater-than, so a balanced two-way split (exactly 50% each)
stays clean at the default 50% warn threshold.

Warnings are sorted most severe first, then largest share first.

## Thresholds

Defaults are 50% to warn and 85% to escalate, for both assets and protocols.

Override them per deployment with environment variables (shares in `(0, 1]`):

| Variable | Default |
| --- | --- |
| `CONCENTRATION_ASSET_WARN_SHARE` | `0.5` |
| `CONCENTRATION_ASSET_CRITICAL_SHARE` | `0.85` |
| `CONCENTRATION_PROTOCOL_WARN_SHARE` | `0.5` |
| `CONCENTRATION_PROTOCOL_CRITICAL_SHARE` | `0.85` |

Anything missing, unparseable, or out of range falls back to the default, so a bad
value degrades to safe behaviour rather than disabling the warnings. A `critical`
below `warn` is raised to `warn` so the critical tier stays reachable.

Callers can also pass thresholds directly, which takes precedence over the environment:

```ts
await PortfolioService.getExposureMap(positions, { asset: { warn: 0.4 } });
```

```tsx
<ExposureMap data={exposure} thresholds={{ protocol: { warn: 0.6 } }} />
```

## Where warnings appear

- **Exposure map** (`client/src/portfolio/ExposureMap.tsx`) — each pie slice shows its
  share, breaching slices are outlined and labelled with their severity, and a warning
  panel below lists every breach with the thresholds in effect.
- **Portfolio summary** (`client/src/components/portfolio/PortfolioDashboard.tsx`) — a
  "Top Exposure" stat card shows the largest single share, plus a banner listing the
  breaches when any exist.
- **Reconciliation** (`server/src/services/portfolioReconcileService.ts`) —
  `ReconciliationResult.concentration` grades the chain-authoritative positions, so
  exposure risk is reported against the snapshot just reconciled. The reconciler works
  in position units and carries no USD prices, so those shares are relative to the
  reconciled total rather than to a priced portfolio value.

## Server API

`PortfolioService.getExposureMap` returns both shapes:

- `concentrationWarnings: string[]` — the messages, unchanged for existing consumers
- `concentration: ConcentrationAnalysis` — shares, severities, and the thresholds used
