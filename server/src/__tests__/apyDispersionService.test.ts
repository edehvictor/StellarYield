import { ApyDispersionService, type ProviderApyInput } from '../services/apyDispersionService';
import { computeAllSourceHealth, computeSourceFreshness, computeSourceConfidence, getFreshnessStatus } from '../services/sourceHealthService';

describe('ApyDispersionService', () => {
  let service: ApyDispersionService;

  beforeEach(() => {
    service = new ApyDispersionService();
  });

  describe('low-dispersion scenarios', () => {
    it('should return low dispersion when providers closely agree', () => {
      const inputs: ProviderApyInput[] = [
        { provider: 'DeFiLlama', apy: 6.5, tvlUsd: 10_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'YieldWatch', apy: 6.4, tvlUsd: 8_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'StellarExpert', apy: 6.6, tvlUsd: 9_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
      ];

      const result = service.computeDispersion('blend-usdc', 'Blend USDC', inputs);

      expect(result.dispersionLevel).toBe('low');
      expect(result.confidenceSignal).toBe('high');
      expect(result.providerCount).toBe(3);
      expect(result.warning).toBeNull();
      expect(result.meanApy).toBeCloseTo(6.5, 1);
    });

    it('should handle single provider input gracefully', () => {
      const inputs: ProviderApyInput[] = [
        { provider: 'DeFiLlama', apy: 8.0, tvlUsd: 5_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
      ];

      const result = service.computeDispersion('soroswap-xlm', 'Soroswap XLM', inputs);

      expect(result.dispersionLevel).toBe('low');
      expect(result.confidenceSignal).toBe('warning');
      expect(result.providerCount).toBe(1);
      expect(result.warning).toBeNull();
    });
  });

  describe('high-dispersion scenarios', () => {
    it('should return high dispersion when providers strongly disagree', () => {
      const inputs: ProviderApyInput[] = [
        { provider: 'DeFiLlama', apy: 5.0, tvlUsd: 10_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'YieldWatch', apy: 7.5, tvlUsd: 8_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'StellarExpert', apy: 4.0, tvlUsd: 9_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
      ];

      const result = service.computeDispersion('blend-usdc', 'Blend USDC', inputs);

      expect(result.dispersionLevel).toBe('high');
      expect(result.confidenceSignal).toBe('low');
      expect(result.coefficientOfVariation).toBeGreaterThan(0.15);
      expect(result.warning).toContain('High APY dispersion');
    });

    it('should detect critical dispersion', () => {
      const inputs: ProviderApyInput[] = [
        { provider: 'ProviderA', apy: 2.0, tvlUsd: 1_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'ProviderB', apy: 20.0, tvlUsd: 500_000, fetchedAt: '2026-05-26T00:00:00Z' },
      ];

      const result = service.computeDispersion('volatile-pool', 'Volatile Pool', inputs);

      expect(result.dispersionLevel).toBe('critical');
      expect(result.confidenceSignal).toBe('warning');
      expect(result.warning).toContain('Critical APY dispersion');
    });
  });

  describe('moderate dispersion', () => {
    it('should detect moderate dispersion', () => {
      const inputs: ProviderApyInput[] = [
        { provider: 'DeFiLlama', apy: 8.0, tvlUsd: 10_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'YieldWatch', apy: 9.5, tvlUsd: 8_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
      ];

      const result = service.computeDispersion('moderate-pool', 'Moderate Pool', inputs);

      expect(result.dispersionLevel).toBe('moderate');
      expect(result.warning).toContain('Moderate APY dispersion');
    });
  });

  describe('edge cases', () => {
    it('should handle empty inputs', () => {
      const result = service.computeDispersion('empty', 'Empty Strategy', []);

      expect(result.providerCount).toBe(0);
      expect(result.meanApy).toBe(0);
      expect(result.warning).toBe('No provider inputs available for dispersion analysis.');
    });

    it('should report correct statistics', () => {
      const inputs: ProviderApyInput[] = [
        { provider: 'A', apy: 10, tvlUsd: 1_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'B', apy: 12, tvlUsd: 2_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'C', apy: 14, tvlUsd: 3_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
      ];

      const result = service.computeDispersion('stat-test', 'Stat Test', inputs);

      expect(result.minApy).toBe(10);
      expect(result.maxApy).toBe(14);
      expect(result.range).toBe(4);
      expect(result.meanApy).toBe(12);
      expect(result.medianApy).toBe(12);
    });

    it('should compute per-source deviation', () => {
      const inputs: ProviderApyInput[] = [
        { provider: 'A', apy: 8, tvlUsd: 1_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'B', apy: 10, tvlUsd: 2_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
      ];

      const result = service.computeDispersion('dev-test', 'Dev Test', inputs);

      expect(result.sources).toHaveLength(2);
      expect(result.sources[0].deviationFromMean).toBe(-1);
      expect(result.sources[1].deviationFromMean).toBe(1);
    });

    it('should include per-source health in sources', () => {
      const inputs: ProviderApyInput[] = [
        { provider: 'A', apy: 8, tvlUsd: 1_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'B', apy: 10, tvlUsd: 2_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
      ];

      const result = service.computeDispersion('health-test', 'Health Test', inputs);

      for (const source of result.sources) {
        expect(source.health).toBeDefined();
        expect(source.health.provider).toBe(source.provider);
        expect(typeof source.health.confidence).toBe('number');
        expect(typeof source.health.freshness).toBe('number');
        expect(source.health.freshnessStatus).toBeDefined();
      }
    });
  });

  describe('config updates', () => {
    it('should allow custom thresholds', () => {
      const customService = new ApyDispersionService({
        lowCvThreshold: 0.01,
        moderateCvThreshold: 0.05,
        highCvThreshold: 0.10,
      });

      const inputs: ProviderApyInput[] = [
        { provider: 'A', apy: 6.5, tvlUsd: 1_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
        { provider: 'B', apy: 6.8, tvlUsd: 2_000_000, fetchedAt: '2026-05-26T00:00:00Z' },
      ];

      const result = customService.computeDispersion('custom', 'Custom', inputs);

      expect(result.dispersionLevel).not.toBe('low');
    });

    it('should update config at runtime', () => {
      service.updateConfig({ lowCvThreshold: 0.02 });
      expect(service.getConfig().lowCvThreshold).toBe(0.02);
    });
  });

  describe('mixed source quality', () => {
    it('should identify stale sources in the breakdown', () => {
      const now = new Date('2026-05-26T12:00:00Z');
      const inputs: ProviderApyInput[] = [
        { provider: 'FreshSource', apy: 8.0, tvlUsd: 10_000_000, fetchedAt: '2026-05-26T11:59:30Z' }, // 30s ago = fresh
        { provider: 'StaleSource', apy: 7.5, tvlUsd: 8_000_000, fetchedAt: '2026-05-26T11:00:00Z' }, // 60 min ago = hard-stale
      ];

      const healthResults = computeAllSourceHealth(inputs, now);

      expect(healthResults).toHaveLength(2);
      const freshSource = healthResults.find(h => h.provider === 'FreshSource')!;
      const staleSource = healthResults.find(h => h.provider === 'StaleSource')!;

      expect(freshSource.freshnessStatus).toBe('fresh');
      expect(freshSource.freshness).toBe(1.0);
      expect(staleSource.freshnessStatus).toBe('hard-stale');
      expect(staleSource.freshness).toBe(0);
    });

    it('should flag low-confidence sources that deviate from mean', () => {
      const now = new Date('2026-05-26T12:00:00Z');
      const inputs: ProviderApyInput[] = [
        { provider: 'A', apy: 10, tvlUsd: 1_000_000, fetchedAt: '2026-05-26T11:59:00Z' },
        { provider: 'B', apy: 10.5, tvlUsd: 2_000_000, fetchedAt: '2026-05-26T11:59:00Z' },
        { provider: 'C', apy: 10.2, tvlUsd: 1_500_000, fetchedAt: '2026-05-26T11:59:00Z' },
        { provider: 'Outlier', apy: 20, tvlUsd: 500_000, fetchedAt: '2026-05-26T11:59:00Z' },
      ];

      const healthResults = computeAllSourceHealth(inputs, now);
      const outlier = healthResults.find(h => h.provider === 'Outlier')!;
      const normal = healthResults.find(h => h.provider === 'A')!;

      // The outlier should have lower confidence due to deviation
      expect(outlier.confidence).toBeLessThan(normal.confidence);
    });

    it('should surface stale sources in dispersion sources array', () => {
      const inputs: ProviderApyInput[] = [
        { provider: 'Fresh', apy: 8.0, tvlUsd: 10_000_000, fetchedAt: new Date().toISOString() },
        { provider: 'Old', apy: 8.1, tvlUsd: 9_000_000, fetchedAt: '2020-01-01T00:00:00Z' },
      ];

      const result = service.computeDispersion('mixed-fresh', 'Mixed Fresh', inputs);

      const freshSrc = result.sources.find(s => s.provider === 'Fresh')!;
      const oldSrc = result.sources.find(s => s.provider === 'Old')!;

      expect(freshSrc.health.freshnessStatus).toBe('fresh');
      expect(oldSrc.health.freshnessStatus).toBe('hard-stale');
    });
  });

  describe('sourceHealthService', () => {
    it('computeSourceFreshness returns 1 for very recent data', () => {
      expect(computeSourceFreshness(0)).toBe(1.0);
      expect(computeSourceFreshness(30_000)).toBe(1.0); // 30s
    });

    it('computeSourceFreshness returns 0 for very old data', () => {
      expect(computeSourceFreshness(45 * 60_000)).toBe(0); // 45 min
      expect(computeSourceFreshness(100 * 60_000)).toBe(0);
    });

    it('computeSourceFreshness interpolates linearly', () => {
      const score = computeSourceFreshness(60_000); // 1 min = boundary
      expect(score).toBe(1.0);

      const midScore = computeSourceFreshness(23 * 60_000); // ~midpoint
      expect(midScore).toBeGreaterThan(0.3);
      expect(midScore).toBeLessThan(0.7);
    });

    it('getFreshnessStatus returns correct status', () => {
      expect(getFreshnessStatus(0)).toBe('fresh');
      expect(getFreshnessStatus(10 * 60_000)).toBe('fresh');
      expect(getFreshnessStatus(11 * 60_000)).toBe('soft-stale');
      expect(getFreshnessStatus(46 * 60_000)).toBe('hard-stale');
    });

    it('computeSourceConfidence penalises high deviation', () => {
      const lowDev = computeSourceConfidence(1.0, 0.1, 10);
      const highDev = computeSourceConfidence(1.0, 5, 10);
      expect(highDev).toBeLessThan(lowDev);
    });

    it('computeSourceConfidence penalises stale data', () => {
      const fresh = computeSourceConfidence(1.0, 0, 10);
      const stale = computeSourceConfidence(0, 0, 10);
      expect(stale).toBeLessThan(fresh);
    });
  });
});
