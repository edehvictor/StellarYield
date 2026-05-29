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
});
