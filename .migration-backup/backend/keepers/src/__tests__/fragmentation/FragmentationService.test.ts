/**
 * Unit tests for FragmentationService
 * 
 * These tests verify specific scenarios, edge cases, and error conditions.
 */

import { FragmentationService } from '../../services/fragmentation/FragmentationService';
import { MetricAggregator, IYieldService, NormalizedYield } from '../../services/fragmentation/MetricAggregator';
import { FragmentationCalculator } from '../../services/fragmentation/FragmentationCalculator';
import { ExecutionQualityScorer, ISlippageRegistry, SlippageEstimate } from '../../services/fragmentation/ExecutionQualityScorer';
import { ThresholdLabeler } from '../../services/fragmentation/ThresholdLabeler';

// Mock yield service for testing
class MockYieldService implements IYieldService {
  constructor(private mockData: NormalizedYield[]) {}

  async getYieldData(): Promise<NormalizedYield[]> {
    return this.mockData;
  }
}

// Mock slippage registry for testing
class MockSlippageRegistry implements ISlippageRegistry {
  async getSlippageEstimate(protocol: string, tradeSize: number): Promise<SlippageEstimate> {
    return {
      protocol,
      estimatedSlippageBps: 15,
      liquidityDepthUsd: tradeSize * 100,
    };
  }
}

describe('FragmentationService', () => {
  let service: FragmentationService;
  let yieldService: MockYieldService;
  let metricAggregator: MetricAggregator;
  let fragmentationCalculator: FragmentationCalculator;
  let executionQualityScorer: ExecutionQualityScorer;
  let thresholdLabeler: ThresholdLabeler;

  const createService = (yieldData: NormalizedYield[]) => {
    yieldService = new MockYieldService(yieldData);
    metricAggregator = new MetricAggregator(yieldService);
    fragmentationCalculator = new FragmentationCalculator();
    executionQualityScorer = new ExecutionQualityScorer(new MockSlippageRegistry());
    thresholdLabeler = new ThresholdLabeler();

    return new FragmentationService(
      metricAggregator,
      fragmentationCalculator,
      executionQualityScorer,
      thresholdLabeler
    );
  };

  describe('getFragmentationMetrics', () => {
    it('calculates complete metrics for typical protocol distribution', async () => {
      const yieldData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 5.2, poolCount: 15 },
        { protocol: 'Soroswap', tvl: 4850000, apy: 6.8, poolCount: 8 },
        { protocol: 'DeFindex', tvl: 2100000, apy: 4.5, poolCount: 5 },
        { protocol: 'Aquarius', tvl: 650000, apy: 7.1, poolCount: 3 },
      ];

      service = createService(yieldData);
      const metrics = await service.getFragmentationMetrics();

      expect(metrics.fragmentationScore).toBeGreaterThanOrEqual(0);
      expect(metrics.fragmentationScore).toBeLessThanOrEqual(100);
      expect(metrics.hhi).toBeGreaterThanOrEqual(0);
      expect(metrics.hhi).toBeLessThanOrEqual(10000);
      expect(metrics.effectiveProtocolCount).toBeGreaterThan(0);
      expect(metrics.executionQualityScore).toBeGreaterThanOrEqual(0);
      expect(metrics.executionQualityScore).toBeLessThanOrEqual(100);
      expect(['Low', 'Medium', 'High']).toContain(metrics.category);
      expect(metrics.protocolBreakdown.length).toBe(4);
      expect(metrics.timestamp).toBeDefined();
      expect(metrics.nextUpdateAt).toBeDefined();
    });

    it('uses cache on second call within TTL', async () => {
      const yieldData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 10000000, apy: 5.0, poolCount: 10 },
      ];

      service = createService(yieldData);

      const metrics1 = await service.getFragmentationMetrics();
      const metrics2 = await service.getFragmentationMetrics();

      // Should return same cached instance
      expect(metrics1.timestamp).toBe(metrics2.timestamp);
      expect(metrics1.fragmentationScore).toBe(metrics2.fragmentationScore);
    });

    it('handles single protocol scenario', async () => {
      const yieldData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 20000000, apy: 5.0, poolCount: 20 },
      ];

      service = createService(yieldData);
      const metrics = await service.getFragmentationMetrics();

      // Single protocol = maximum concentration = HHI of 10000
      expect(metrics.hhi).toBeCloseTo(10000, 1);
      expect(metrics.fragmentationScore).toBeCloseTo(0, 1);
      expect(metrics.category).toBe('Low');
      expect(metrics.effectiveProtocolCount).toBeCloseTo(1, 1);
    });

    it('handles equal distribution scenario', async () => {
      const yieldData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 5000000, apy: 5.0, poolCount: 10 },
        { protocol: 'Soroswap', tvl: 5000000, apy: 6.0, poolCount: 10 },
        { protocol: 'DeFindex', tvl: 5000000, apy: 4.5, poolCount: 10 },
        { protocol: 'Aquarius', tvl: 5000000, apy: 7.0, poolCount: 10 },
      ];

      service = createService(yieldData);
      const metrics = await service.getFragmentationMetrics();

      // Equal distribution = lower HHI = higher fragmentation
      expect(metrics.fragmentationScore).toBeGreaterThan(50);
      expect(metrics.category).toBe('High');
      expect(metrics.effectiveProtocolCount).toBeCloseTo(4, 1);
    });

    it('throws error when no protocol data available', async () => {
      const yieldData: NormalizedYield[] = [];

      service = createService(yieldData);

      await expect(service.getFragmentationMetrics()).rejects.toThrow(
        'Cannot calculate fragmentation metrics: no protocol data available'
      );
    });
  });

  describe('refreshMetrics', () => {
    it('bypasses cache and recalculates metrics', async () => {
      const yieldData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 10000000, apy: 5.0, poolCount: 10 },
      ];

      service = createService(yieldData);

      const metrics1 = await service.getFragmentationMetrics();
      
      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      const metrics2 = await service.refreshMetrics();

      // Should have different timestamps (recalculated)
      expect(metrics1.timestamp).not.toBe(metrics2.timestamp);
    });
  });

  describe('getRoutingRecommendation', () => {
    beforeEach(() => {
      const yieldData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 5.2, poolCount: 15 },
        { protocol: 'Soroswap', tvl: 4850000, apy: 6.8, poolCount: 8 },
      ];
      service = createService(yieldData);
    });

    it('recommends single-protocol routing for low fragmentation', () => {
      const recommendation = service.getRoutingRecommendation(15, 85);

      expect(recommendation.strategy).toBe('single-protocol');
      expect(recommendation.reasoning).toContain('Single-protocol routing');
      expect(recommendation.alternativeSuggestions.length).toBe(0);
    });

    it('recommends multi-protocol routing for high fragmentation', () => {
      const recommendation = service.getRoutingRecommendation(75, 85);

      expect(recommendation.strategy).toBe('multi-protocol');
      expect(recommendation.reasoning).toContain('Multi-protocol routing');
    });

    it('recommends multi-protocol routing for medium fragmentation', () => {
      const recommendation = service.getRoutingRecommendation(45, 85);

      expect(recommendation.strategy).toBe('multi-protocol');
      expect(recommendation.reasoning).toContain('moderately distributed');
    });

    it('provides alternative suggestions when execution quality is degraded', () => {
      const recommendation = service.getRoutingRecommendation(50, 65);

      expect(recommendation.alternativeSuggestions.length).toBeGreaterThan(0);
      expect(recommendation.alternativeSuggestions.some(s => s.includes('splitting large orders'))).toBe(true);
    });

    it('provides no suggestions when execution quality is good', () => {
      const recommendation = service.getRoutingRecommendation(50, 85);

      expect(recommendation.alternativeSuggestions.length).toBe(0);
    });

    it('throws error for invalid fragmentation score', () => {
      expect(() => service.getRoutingRecommendation(-10, 85)).toThrow(
        'Invalid fragmentation score'
      );
      expect(() => service.getRoutingRecommendation(150, 85)).toThrow(
        'Invalid fragmentation score'
      );
    });

    it('throws error for invalid execution quality', () => {
      expect(() => service.getRoutingRecommendation(50, -10)).toThrow(
        'Invalid execution quality'
      );
      expect(() => service.getRoutingRecommendation(50, 150)).toThrow(
        'Invalid execution quality'
      );
    });

    it('handles boundary values correctly', () => {
      // Exactly at low threshold (30)
      const rec1 = service.getRoutingRecommendation(30, 85);
      expect(rec1.strategy).toBe('multi-protocol');

      // Just below low threshold
      const rec2 = service.getRoutingRecommendation(29.99, 85);
      expect(rec2.strategy).toBe('single-protocol');

      // Exactly at high threshold (60)
      const rec3 = service.getRoutingRecommendation(60, 85);
      expect(rec3.strategy).toBe('multi-protocol');

      // Just above high threshold
      const rec4 = service.getRoutingRecommendation(60.01, 85);
      expect(rec4.strategy).toBe('multi-protocol');

      // Exactly at material impact threshold (70)
      const rec5 = service.getRoutingRecommendation(50, 70);
      expect(rec5.alternativeSuggestions.length).toBe(0);

      // Just below material impact threshold
      const rec6 = service.getRoutingRecommendation(50, 69.99);
      expect(rec6.alternativeSuggestions.length).toBeGreaterThan(0);
    });
  });

  describe('cache management', () => {
    it('clears cache when clearCache is called', async () => {
      const yieldData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 10000000, apy: 5.0, poolCount: 10 },
      ];

      service = createService(yieldData);

      const metrics1 = await service.getFragmentationMetrics();
      service.clearCache();
      
      // Wait a bit to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      const metrics2 = await service.getFragmentationMetrics();

      // Should have different timestamps (recalculated after cache clear)
      expect(metrics1.timestamp).not.toBe(metrics2.timestamp);
    });
  });

  describe('polling management', () => {
    it('starts and stops polling without errors', () => {
      const yieldData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 10000000, apy: 5.0, poolCount: 10 },
      ];

      service = createService(yieldData);

      expect(() => service.startPolling()).not.toThrow();
      expect(() => service.stopPolling()).not.toThrow();
    });
  });

  describe('deepest protocol identification', () => {
    it('identifies deepest protocol correctly after metrics calculation', async () => {
      const yieldData: NormalizedYield[] = [
        { protocol: 'Blend', tvl: 12400000, apy: 5.2, poolCount: 15 },
        { protocol: 'Soroswap', tvl: 4850000, apy: 6.8, poolCount: 8 },
        { protocol: 'DeFindex', tvl: 2100000, apy: 4.5, poolCount: 5 },
      ];

      service = createService(yieldData);
      await service.getFragmentationMetrics();

      const recommendation = service.getRoutingRecommendation(50, 85);

      expect(recommendation.deepestProtocol).toBe('Blend');
    });
  });
});
