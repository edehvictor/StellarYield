/**
 * Property-based tests for FragmentationService
 * 
 * These tests verify universal correctness properties across all valid inputs
 * using the fast-check library for property-based testing.
 */

import fc from 'fast-check';
import { FragmentationService } from '../../services/fragmentation/FragmentationService';
import { MetricAggregator, IYieldService, NormalizedYield } from '../../services/fragmentation/MetricAggregator';
import { FragmentationCalculator } from '../../services/fragmentation/FragmentationCalculator';
import { ExecutionQualityScorer, ISlippageRegistry, SlippageEstimate } from '../../services/fragmentation/ExecutionQualityScorer';
import { ThresholdLabeler } from '../../services/fragmentation/ThresholdLabeler';
import { ProtocolLiquidityData, FragmentationMetrics } from '../../services/fragmentation/types';

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

describe('FragmentationService - Property Tests', () => {
  /**
   * Property 5: Timestamp Presence
   * 
   * For all calculated metrics, the output SHALL include a timestamp field
   * containing a valid ISO 8601 datetime string.
   * 
   * Validates: Requirements 1.5
   */
  describe('Property 5: Timestamp Presence', () => {
    it('includes valid ISO 8601 timestamp in all metrics', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              protocol: fc.constantFrom('Blend', 'Soroswap', 'DeFindex', 'Aquarius'),
              tvl: fc.integer({ min: 100000, max: 100000000 }),
              apy: fc.float({ min: 0, max: 50 }),
              poolCount: fc.integer({ min: 1, max: 50 }),
            }),
            { minLength: 1, maxLength: 4 }
          ),
          async (yieldData: NormalizedYield[]) => {
            // Create service with mock data
            const yieldService = new MockYieldService(yieldData);
            const metricAggregator = new MetricAggregator(yieldService);
            const fragmentationCalculator = new FragmentationCalculator();
            const executionQualityScorer = new ExecutionQualityScorer(new MockSlippageRegistry());
            const thresholdLabeler = new ThresholdLabeler();

            const service = new FragmentationService(
              metricAggregator,
              fragmentationCalculator,
              executionQualityScorer,
              thresholdLabeler
            );

            const metrics = await service.getFragmentationMetrics();

            // Verify timestamp field exists
            expect(metrics.timestamp).toBeDefined();
            expect(typeof metrics.timestamp).toBe('string');

            // Verify it's a valid ISO 8601 datetime
            const timestampDate = new Date(metrics.timestamp);
            expect(timestampDate.toISOString()).toBe(metrics.timestamp);
            expect(isNaN(timestampDate.getTime())).toBe(false);

            // Verify nextUpdateAt field exists and is valid
            expect(metrics.nextUpdateAt).toBeDefined();
            expect(typeof metrics.nextUpdateAt).toBe('string');
            const nextUpdateDate = new Date(metrics.nextUpdateAt);
            expect(nextUpdateDate.toISOString()).toBe(metrics.nextUpdateAt);
            expect(isNaN(nextUpdateDate.getTime())).toBe(false);

            // Verify nextUpdateAt is after timestamp
            expect(nextUpdateDate.getTime()).toBeGreaterThan(timestampDate.getTime());
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 10: API Response Structure Completeness
   * 
   * For any valid API request, the response SHALL contain all required fields:
   * fragmentationScore, hhi, effectiveProtocolCount, executionQualityScore,
   * category, timestamp, and dataCompleteness.
   * 
   * Validates: Requirements 3.2
   */
  describe('Property 10: API Response Structure Completeness', () => {
    it('returns all required fields in metrics response', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              protocol: fc.constantFrom('Blend', 'Soroswap', 'DeFindex', 'Aquarius'),
              tvl: fc.integer({ min: 100000, max: 100000000 }),
              apy: fc.float({ min: 0, max: 50 }),
              poolCount: fc.integer({ min: 1, max: 50 }),
            }),
            { minLength: 1, maxLength: 4 }
          ),
          async (yieldData: NormalizedYield[]) => {
            const yieldService = new MockYieldService(yieldData);
            const metricAggregator = new MetricAggregator(yieldService);
            const fragmentationCalculator = new FragmentationCalculator();
            const executionQualityScorer = new ExecutionQualityScorer(new MockSlippageRegistry());
            const thresholdLabeler = new ThresholdLabeler();

            const service = new FragmentationService(
              metricAggregator,
              fragmentationCalculator,
              executionQualityScorer,
              thresholdLabeler
            );

            const metrics = await service.getFragmentationMetrics();

            // Verify all required fields are present
            expect(metrics).toHaveProperty('fragmentationScore');
            expect(metrics).toHaveProperty('hhi');
            expect(metrics).toHaveProperty('effectiveProtocolCount');
            expect(metrics).toHaveProperty('multiProtocolRoutingPct');
            expect(metrics).toHaveProperty('executionQualityScore');
            expect(metrics).toHaveProperty('materialImpact');
            expect(metrics).toHaveProperty('category');
            expect(metrics).toHaveProperty('categoryDescription');
            expect(metrics).toHaveProperty('protocolBreakdown');
            expect(metrics).toHaveProperty('dataCompleteness');
            expect(metrics).toHaveProperty('timestamp');
            expect(metrics).toHaveProperty('nextUpdateAt');

            // Verify field types
            expect(typeof metrics.fragmentationScore).toBe('number');
            expect(typeof metrics.hhi).toBe('number');
            expect(typeof metrics.effectiveProtocolCount).toBe('number');
            expect(typeof metrics.multiProtocolRoutingPct).toBe('number');
            expect(typeof metrics.executionQualityScore).toBe('number');
            expect(typeof metrics.materialImpact).toBe('boolean');
            expect(typeof metrics.category).toBe('string');
            expect(typeof metrics.categoryDescription).toBe('string');
            expect(Array.isArray(metrics.protocolBreakdown)).toBe(true);
            expect(typeof metrics.dataCompleteness).toBe('object');
            expect(typeof metrics.timestamp).toBe('string');
            expect(typeof metrics.nextUpdateAt).toBe('string');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 19: High Fragmentation Routing Recommendation
   * 
   * For any fragmentation scenario where the score is greater than 60 (High category),
   * the Fragmentation Analyzer SHALL recommend multi-protocol routing strategies.
   * 
   * Validates: Requirements 8.1
   */
  describe('Property 19: High Fragmentation Routing Recommendation', () => {
    it('recommends multi-protocol routing for high fragmentation (score > 60)', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 60.01, max: 100, noNaN: true }),
          fc.double({ min: 0, max: 100, noNaN: true }),
          (fragmentationScore: number, executionQuality: number) => {
            const yieldService = new MockYieldService([]);
            const metricAggregator = new MetricAggregator(yieldService);
            const fragmentationCalculator = new FragmentationCalculator();
            const executionQualityScorer = new ExecutionQualityScorer(new MockSlippageRegistry());
            const thresholdLabeler = new ThresholdLabeler();

            const service = new FragmentationService(
              metricAggregator,
              fragmentationCalculator,
              executionQualityScorer,
              thresholdLabeler
            );

            const recommendation = service.getRoutingRecommendation(
              fragmentationScore,
              executionQuality
            );

            expect(recommendation.strategy).toBe('multi-protocol');
            expect(recommendation.reasoning).toBeDefined();
            expect(recommendation.reasoning.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 20: Low Fragmentation Routing Recommendation
   * 
   * For any fragmentation scenario where the score is less than 30 (Low category),
   * the Fragmentation Analyzer SHALL recommend single-protocol routing.
   * 
   * Validates: Requirements 8.2
   */
  describe('Property 20: Low Fragmentation Routing Recommendation', () => {
    it('recommends single-protocol routing for low fragmentation (score < 30)', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 29.99, noNaN: true }),
          fc.double({ min: 0, max: 100, noNaN: true }),
          (fragmentationScore: number, executionQuality: number) => {
            const yieldService = new MockYieldService([]);
            const metricAggregator = new MetricAggregator(yieldService);
            const fragmentationCalculator = new FragmentationCalculator();
            const executionQualityScorer = new ExecutionQualityScorer(new MockSlippageRegistry());
            const thresholdLabeler = new ThresholdLabeler();

            const service = new FragmentationService(
              metricAggregator,
              fragmentationCalculator,
              executionQualityScorer,
              thresholdLabeler
            );

            const recommendation = service.getRoutingRecommendation(
              fragmentationScore,
              executionQuality
            );

            expect(recommendation.strategy).toBe('single-protocol');
            expect(recommendation.reasoning).toBeDefined();
            expect(recommendation.reasoning.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 21: Deepest Liquidity Protocol Identification
   * 
   * For any set of protocol liquidity data, the Fragmentation Analyzer SHALL
   * correctly identify the protocol with the maximum TVL as having the deepest liquidity.
   * 
   * Validates: Requirements 8.3
   */
  describe('Property 21: Deepest Liquidity Protocol Identification', () => {
    it('identifies protocol with maximum TVL as deepest', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              protocol: fc.constantFrom('Blend', 'Soroswap', 'DeFindex', 'Aquarius'),
              tvl: fc.integer({ min: 100000, max: 100000000 }),
              apy: fc.float({ min: 0, max: 50 }),
              poolCount: fc.integer({ min: 1, max: 50 }),
            }),
            { minLength: 2, maxLength: 4 }
          ),
          async (yieldData: NormalizedYield[]) => {
            // Ensure unique protocols
            const uniqueData = Array.from(
              new Map(yieldData.map((item) => [item.protocol, item])).values()
            );

            if (uniqueData.length < 2) {
              return; // Skip if not enough unique protocols
            }

            const yieldService = new MockYieldService(uniqueData);
            const metricAggregator = new MetricAggregator(yieldService);
            const fragmentationCalculator = new FragmentationCalculator();
            const executionQualityScorer = new ExecutionQualityScorer(new MockSlippageRegistry());
            const thresholdLabeler = new ThresholdLabeler();

            const service = new FragmentationService(
              metricAggregator,
              fragmentationCalculator,
              executionQualityScorer,
              thresholdLabeler
            );

            const metrics = await service.getFragmentationMetrics();

            // Find protocol with maximum TVL from input data
            const maxTvlProtocol = uniqueData.reduce((max, current) =>
              current.tvl > max.tvl ? current : max
            );

            // Find the deepest protocol in the breakdown
            const deepestInBreakdown = metrics.protocolBreakdown.find((p) => p.isDeepest);

            expect(deepestInBreakdown).toBeDefined();
            expect(deepestInBreakdown!.protocol).toBe(maxTvlProtocol.protocol);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 22: Degraded Quality Alternative Suggestions
   * 
   * For any execution quality score below 70 (material impact), the Fragmentation
   * Analyzer SHALL provide at least one alternative trading strategy or timing suggestion.
   * 
   * Validates: Requirements 8.4
   */
  describe('Property 22: Degraded Quality Alternative Suggestions', () => {
    it('provides alternative suggestions when execution quality is degraded (< 70)', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 100, noNaN: true }),
          fc.double({ min: 0, max: 69.99, noNaN: true }),
          (fragmentationScore: number, executionQuality: number) => {
            const yieldService = new MockYieldService([]);
            const metricAggregator = new MetricAggregator(yieldService);
            const fragmentationCalculator = new FragmentationCalculator();
            const executionQualityScorer = new ExecutionQualityScorer(new MockSlippageRegistry());
            const thresholdLabeler = new ThresholdLabeler();

            const service = new FragmentationService(
              metricAggregator,
              fragmentationCalculator,
              executionQualityScorer,
              thresholdLabeler
            );

            const recommendation = service.getRoutingRecommendation(
              fragmentationScore,
              executionQuality
            );

            // Should have at least one alternative suggestion
            expect(recommendation.alternativeSuggestions).toBeDefined();
            expect(Array.isArray(recommendation.alternativeSuggestions)).toBe(true);
            expect(recommendation.alternativeSuggestions.length).toBeGreaterThanOrEqual(1);

            // All suggestions should be non-empty strings
            recommendation.alternativeSuggestions.forEach((suggestion) => {
              expect(typeof suggestion).toBe('string');
              expect(suggestion.length).toBeGreaterThan(0);
            });
          }
        ),
        { numRuns: 100 }
      );
    });

    it('provides no or fewer suggestions when execution quality is good (>= 70)', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 100, noNaN: true }),
          fc.double({ min: 70, max: 100, noNaN: true }),
          (fragmentationScore: number, executionQuality: number) => {
            const yieldService = new MockYieldService([]);
            const metricAggregator = new MetricAggregator(yieldService);
            const fragmentationCalculator = new FragmentationCalculator();
            const executionQualityScorer = new ExecutionQualityScorer(new MockSlippageRegistry());
            const thresholdLabeler = new ThresholdLabeler();

            const service = new FragmentationService(
              metricAggregator,
              fragmentationCalculator,
              executionQualityScorer,
              thresholdLabeler
            );

            const recommendation = service.getRoutingRecommendation(
              fragmentationScore,
              executionQuality
            );

            // Should have empty or minimal suggestions when quality is good
            expect(recommendation.alternativeSuggestions).toBeDefined();
            expect(Array.isArray(recommendation.alternativeSuggestions)).toBe(true);
            expect(recommendation.alternativeSuggestions.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
