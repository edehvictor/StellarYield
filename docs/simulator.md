# Simulator

StellarYield exposes deposit, rebalance, and backtest simulators under `/api/simulator/*`. Client UI lives in `client/src/features/simulator/`; server logic is in `server/src/services/simulationService.ts`.

## Endpoints

| Route | Purpose |
|-------|---------|
| `POST /api/simulator/deposit` | Preview deposit allocation, fees, and warnings |
| `POST /api/simulator/rebalance` | Preview a rebalance before execution |
| `POST /api/simulator/rebalance-backtest` | Run a deterministic historical rebalance backtest |

All simulator responses include `isSimulationOnly: true`.

## Shared fixtures

Canonical fixtures live in `shared/test-fixtures/simulatorFixtures.ts` and are exercised by both:

- `server/src/__tests__/sharedSimulatorFixtures.test.ts`
- `client/src/features/simulator/__tests__/sharedSimulatorFixtures.test.ts`

Fixture families:

| Export | Description |
|--------|-------------|
| `SIMULATOR_FIXTURES` | Deposit scenarios |
| `REBALANCE_FIXTURES` | Rebalance preview scenarios |
| `FAILOVER_FIXTURES` | Static-APY backtest scenarios |
| `BACKTEST_BENCHMARK_FIXTURES` | Volatile, flat, and declining yield markets |

## Backtest benchmark fixtures (#1043)

Benchmark fixtures model three common yield market shapes over a 90-day window (`2025-01-01` → `2025-03-31`):

| Regime | APY shape | Helper |
|--------|-----------|--------|
| **volatile** | Alternating 15% / 3% daily APY | `buildVolatileApySeries(days)` |
| **flat** | Constant 8.5% APY | `buildFlatApySeries(days)` |
| **declining** | Linear 10% → 7% APY | `buildDecliningApySeries(days)` |

Each allocation may include a `dailyApy: number[]` series. When present, `runRebalanceBacktest` uses the per-day APY instead of the constant `apy` field.

### Expected snapshot fields

Backtests emit one `RebalanceBacktestSnapshot` per day:

```ts
{
  date: string;              // YYYY-MM-DD
  portfolioValue: number;    // rebalanced portfolio USD
  passiveValue: number;      // passive benchmark USD
  rebalanced: boolean;
  blendedApyPct: number;
}
```

Benchmark validators (`validateBacktestBenchmarkResult`) assert:

- Snapshot count matches the date range
- Portfolio and passive return percentages fall in regime-specific ranges
- Rebalance count and fee totals stay within bounds
- Maximum drawdown stays below the regime ceiling

## Adding a new benchmark fixture

1. Add a builder in `shared/test-fixtures/simulatorFixtures.ts` if you need a new APY curve.
2. Append a `BacktestBenchmarkFixture` entry to `BACKTEST_BENCHMARK_FIXTURES` with:
   - `input`: backtest params (include `dailyApy` when APY varies over time)
   - `expectedOutput`: ranges for return %, fees, drawdown, and snapshot count
3. Run server tests:

```bash
cd server
./node_modules/.bin/jest --testPathPatterns=sharedSimulatorFixtures.test.ts
```

4. Run client fixture contract tests:

```bash
cd client
./node_modules/.bin/vitest run sharedSimulatorFixtures.test.ts
```

Keep fixtures deterministic — do not use random values. Same input must always produce the same snapshots.

## Required allocation fields

| Field | Type | Notes |
|-------|------|-------|
| `label` | string | Display name |
| `targetWeight` | number | 0–100; all allocations must sum to ~100 |
| `apy` | number | Fallback annual % when `dailyApy` is absent. May be negative, down to `-100` |
| `dailyApy` | number[] | Optional per-day annual % series (length = backtest days). Entries may be negative, down to `-36500` |

## Negative yield periods

Yields can be negative: a depeg, a slashing event, an impermanent-loss drawdown, or a strategy that costs more than it earns. The rebalance preview and the backtest both accept them and apply them as losses to principal.

| Input | Accepted range | Why |
|-------|----------------|-----|
| `apy` (standing assumption) | `-100` to `10000` (preview) / `-100` and up (backtest) | `-100` is a total loss over a year. A lower rate is not a meaningful long-run assumption. |
| `dailyApy[i]` | `-36500` and up | Each day compounds by `1 + apy / 100 / 365`; at `-36500` that factor reaches zero, so the allocation loses all of its value in one day. Below it the value would go negative. |

To model a sharp, short loss (for example a 20% depeg in a day), use a `dailyApy` series: `-7300` is a 20% fall in one day. The fields must be finite numbers; `NaN`, `Infinity`, strings and non-array `dailyApy` values are rejected with a `400` and a message naming the offending entry.

A value that reaches zero stays at zero: the engine never lets a position go below nothing, skips rebalancing when there is nothing left to rebalance, and never produces `NaN` weights. A threshold rebalance after a loss re-funds the depleted allocation from the others (less the turnover fee).

The backtest result adds three fields, all additive to the existing response:

| Field | Meaning |
|-------|---------|
| `negativeYieldDays` | Days on which the rebalanced portfolio's blended yield was negative |
| `maxDrawdownPct` | Largest peak-to-trough fall of the rebalanced portfolio, as a positive % (`0` when it never falls) |
| `passiveMaxDrawdownPct` | The same for the passive benchmark |

Two structured warnings describe a loss (see `shared/types/simulationWarning.ts`):

- `NEGATIVE_YIELD_PERIOD` — one per allocation that earns a negative yield during the window, with the number of negative days and the worst rate. The preview emits it for a negative-yield leg that keeps a target weight. `affectedField` points at `apy` or `dailyApy`.
- `CAPITAL_LOSS` — the rebalanced portfolio ends below its starting value.

The vault contract charges its performance fee only on positive yield (`apply_performance_fee` returns `(0, 0)` for zero or negative yield), so the simulator charges no performance fee on loss days; it models only the turnover fee on rebalances.

## Related docs

- [Fee assumptions](./fee-assumptions.md)
- [Backend testing](./backend_testing.md)
