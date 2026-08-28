import { simulateTreasury, assertValidScenarioInput } from '../treasurySimulationService';

describe('Treasury Simulation Service — Valuation Provenance (#894)', () => {
  it('accepts scenarios with explicit provenance fields', () => {
    const input = {
      id: 'ts-1',
      name: 'Conservative',
      totalCapitalUsd: 1_000_000,
      allocations: [
        {
          vaultId: 'V1',
          vaultName: 'StableVault',
          allocationPct: 60,
          apy: 4.5,
          tvlUsd: 10_000_000,
          riskScore: 2,
          rotationCostPct: 0.1,
          priceSource: 'chainlink',
          priceTimestamp: new Date().toISOString(),
          confidence: 0.95,
        },
        {
          vaultId: 'V2',
          vaultName: 'GrowthVault',
          allocationPct: 40,
          apy: 8.2,
          tvlUsd: 5_000_000,
          riskScore: 6,
          rotationCostPct: 0.5,
          priceSource: 'direct-feed',
          priceTimestamp: new Date(Date.now() - 120_000).toISOString(),
          confidence: 0.8,
        },
      ],
      createdAt: new Date().toISOString(),
    };

    expect(() => assertValidScenarioInput(input)).not.toThrow();
    const scenario = assertValidScenarioInput(input);
    const result = simulateTreasury(scenario);
    expect(result.projectedYieldUsd).toBeGreaterThan(0);
    expect(result.allocationBreakdown).toHaveLength(2);
  });

  it('simulateTreasury uses APY inputs and documents.source fields', () => {
    const scenario = assertValidScenarioInput({
      id: 'ts-2',
      name: 'APY-check',
      totalCapitalUsd: 500_000,
      allocations: [
        {
          vaultId: 'V3',
          vaultName: 'BlueChip',
          allocationPct: 100,
          apy: 6.0,
          tvlUsd: 50_000_000,
          riskScore: 3,
          rotationCostPct: 0.2,
        },
      ],
    });

    const result = simulateTreasury(scenario);
    expect(result.projectedYieldPct).toBeCloseTo(6.0, 1);
    expect(result.allocationBreakdown[0].projectedYieldUsd).toBeCloseTo(30_000, 0);
  });
});