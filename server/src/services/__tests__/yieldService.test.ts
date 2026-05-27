import { aggregateApy } from '../yieldService';

describe('aggregateApy', () => {
  test('aligned providers produce a consensus near their mean', () => {
    const readings = [
      { provider: 'A', apy: 0.05 },
      { provider: 'B', apy: 0.051 },
      { provider: 'C', apy: 0.049 },
    ];
    const { consensusApy, confidence } = aggregateApy(readings as any);
    expect(consensusApy).toBeGreaterThan(0.048);
    expect(consensusApy).toBeLessThan(0.052);
    expect(confidence.score).toBeGreaterThan(50);
  });

  test('an outlier is downweighted and does not move consensus far', () => {
    const readings = [
      { provider: 'A', apy: 0.05 },
      { provider: 'B', apy: 0.049 },
      { provider: 'C', apy: 0.2 }, // outlier
    ];
    const { consensusApy, confidence } = aggregateApy(readings as any);
    expect(consensusApy).toBeLessThan(0.07);
    expect(confidence.reasons).toContain('outliers_downweighted');
  });

  test('missing data returns null consensus', () => {
    const readings: any[] = [];
    const { consensusApy, confidence } = aggregateApy(readings as any);
    expect(consensusApy).toBeNull();
    expect(confidence.score).toBe(0);
  });
});
