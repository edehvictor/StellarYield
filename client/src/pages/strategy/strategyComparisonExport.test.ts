import { describe, expect, it } from 'vitest';
import {
  STRATEGY_COMPARISON_EXPORT_FIELDS,
  buildStrategyComparisonExportRows,
  createStrategyComparisonExportFilename,
  serializeStrategyComparisonExport,
  type StrategyYield,
} from './strategyComparisonExport';

const generatedAt = new Date('2026-05-28T12:34:56.789Z');

const strategies: StrategyYield[] = [
  {
    protocolName: 'Blend',
    apy: 6.45,
    rewardApy: 2.23,
    totalApy: 8.68,
    tvl: 12_400_000,
    riskScore: 23,
    liquidityUsd: 11_200_000,
    rebalancingBehavior: 'Static',
    managementFeeBps: 25,
    performanceFeeBps: 1000,
    capitalEfficiencyPct: 75,
    fetchedAt: '2026-05-28T12:00:00.000Z',
  },
];

describe('strategy comparison export', () => {
  it('uses a standardized timestamped filename', () => {
    expect(createStrategyComparisonExportFilename('csv', generatedAt)).toBe(
      'stellaryield-strategy-comparison-2026-05-28T12-34-56-789Z.csv',
    );
  });

  it('exports required comparison fields', () => {
    const [row] = buildStrategyComparisonExportRows(strategies, generatedAt);

    expect(Object.keys(row)).toEqual([...STRATEGY_COMPARISON_EXPORT_FIELDS]);
    expect(row.protocol_name).toBe('Blend');
    expect(row.total_apy).toBe(8.68);
    expect(row.tvl_usd).toBe(12_400_000);
    expect(row.risk_score).toBe(23);
    expect(row.fee_drag_bps).toBe(1025);
    expect(row.confidence_score).toBe(75);
    expect(row.generated_at).toBe(generatedAt.toISOString());
  });

  it('keeps CSV headers when there are no strategies', () => {
    const csv = serializeStrategyComparisonExport([], 'csv', generatedAt);

    expect(csv).toBe(STRATEGY_COMPARISON_EXPORT_FIELDS.join(','));
  });

  it('serializes JSON with metadata and rows', () => {
    const json = JSON.parse(
      serializeStrategyComparisonExport(strategies, 'json', generatedAt),
    ) as {
      generated_at: string;
      row_count: number;
      fields: string[];
      strategies: Array<{ protocol_name: string }>;
    };

    expect(json.generated_at).toBe(generatedAt.toISOString());
    expect(json.row_count).toBe(1);
    expect(json.fields).toEqual([...STRATEGY_COMPARISON_EXPORT_FIELDS]);
    expect(json.strategies[0].protocol_name).toBe('Blend');
  });

  // Regression tests for malformed external data handling
  it('filters out malformed strategy entries when building export rows', () => {
    // Mix of valid and invalid entries - only DeFindex has all required fields
    const malformedStrategies: unknown[] = [
      { protocolName: 'Blend', apy: 6.45, rewardApy: 2.23, totalApy: 8.68, tvl: 12_400_000, riskScore: 23, liquidityUsd: 11_200_000, rebalancingBehavior: 'Static', managementFeeBps: 0, performanceFeeBps: 1000, capitalEfficiencyPct: 75, fetchedAt: '2026-05-28T12:00:00.000Z' }, // missing some fields but type-wise OK
      { protocolName: '', apy: 5, tvl: 1000, riskScore: 10 }, // empty protocolName
      { protocolName: 123, apy: 5, tvl: 1000, riskScore: 10 }, // non-string protocolName
      { protocolName: 'Soroswap', apy: 'bad', tvl: 1000, riskScore: 10 }, // apy is string
      { protocolName: 'DeFindex', apy: 9.25, rewardApy: 1.4, totalApy: 10.65, tvl: 2150000, riskScore: 45, liquidityUsd: 1850000, rebalancingBehavior: 'Yield-Weighted', managementFeeBps: 50, performanceFeeBps: 2000, capitalEfficiencyPct: 88, fetchedAt: '2026-05-28T12:00:00.000Z' }, // valid
    ];
    const rows = buildStrategyComparisonExportRows(malformedStrategies as StrategyYield[], generatedAt);

    // Should have valid entries (Blend and DeFindex) after filtering out malformed data
    expect(rows.length).toBe(2);
    // First valid entry should be Blend
    expect(rows.find((r) => r.protocol_name === 'Blend')?.total_apy).toBe(8.68);
    // Second valid entry should be DeFindex
    expect(rows.find((r) => r.protocol_name === 'DeFindex')?.total_apy).toBe(10.65);
  });

  it('handles all-malformed entries by producing empty CSV/JSON', () => {
    // All entries are malformed
    const allMalformed: StrategyYield[] = [
      { protocolName: '', apy: 'bad', tvl: -1, riskScore: 'x' },
      { protocolName: 42, apy: undefined, tvl: null, riskScore: null },
    ];
    const rows = buildStrategyComparisonExportRows(allMalformed, generatedAt);

    // Should filter out all malformed entries, leaving only empty rows structure
    expect(rows.length).toBe(0);
  });

  it('serializes JSON with zero rows when all entries are filtered', () => {
    const allMalformed: StrategyYield[] = [
      { protocolName: '', apy: 'bad', tvl: -1, riskScore: 'x' },
    ];
    const json = JSON.parse(
      serializeStrategyComparisonExport(allMalformed, 'json', generatedAt),
    ) as {
      generated_at: string;
      row_count: number;
      fields: string[];
      strategies: Array<{ protocol_name: string }>;
    };

    expect(json.row_count).toBe(0);
    expect(json.fields).toEqual([...STRATEGY_COMPARISON_EXPORT_FIELDS]);
  });
});

describe('strategy comparison export — boundary values (#1922)', () => {
  const base = strategies[0];

  it('exports zero and maximum fees with a checked fee-drag sum', () => {
    const [zero] = buildStrategyComparisonExportRows(
      [{ ...base, managementFeeBps: 0, performanceFeeBps: 0, tvl: 0, liquidityUsd: 0, riskScore: 0 }],
      generatedAt,
    );
    expect(zero.fee_drag_bps).toBe(0);
    expect(zero.tvl_usd).toBe(0);
    expect(zero.risk_score).toBe(0);

    const [max] = buildStrategyComparisonExportRows(
      [{ ...base, managementFeeBps: 10_000, performanceFeeBps: 10_000, riskScore: 100 }],
      generatedAt,
    );
    expect(max.fee_drag_bps).toBe(20_000);
    expect(max.risk_score).toBe(100);
  });

  it('rounds exported numbers half-up to two decimals', () => {
    const [row] = buildStrategyComparisonExportRows(
      [{ ...base, apy: 6.455, totalApy: 8.675, tvl: 1_000.005 }],
      generatedAt,
    );
    expect(row.apy).toBe(6.46);
    expect(row.total_apy).toBe(8.68);
    expect(row.tvl_usd).toBe(1_000.01);
  });

  it('drops rows past a limit and leaves the input untouched', () => {
    const input: StrategyYield[] = [
      base,
      { ...base, protocolName: 'Soroswap', managementFeeBps: 10_001 },
      { ...base, protocolName: 'DeFindex', liquidityUsd: -1 },
      { ...base, protocolName: 'Blend', riskScore: 101 },
      { ...base, protocolName: 'Blend', tvl: Number.POSITIVE_INFINITY },
    ];
    const snapshot = JSON.stringify(input);
    const rows = buildStrategyComparisonExportRows(input, generatedAt);
    expect(rows).toHaveLength(1);
    expect(rows[0].protocol_name).toBe('Blend');
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
