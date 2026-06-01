import { ApyDispersionService, type ProviderApyInput } from '../services/apyDispersionService';

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
});
