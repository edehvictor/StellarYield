/**
 * Property-based tests for MetricAggregator
 * 
 * These tests verify universal correctness properties for data aggregation.
 */

import fc from 'fast-check';
import { MetricAggregator, NormalizedYield, IYieldService } from '../../services/fragmentation/MetricAggregator';
import { ProtocolLiquidityData } from '../../services/fragmentation/types';

describe('MetricAggregator - Property Tests', () => {
  /**
   * Property 17: Data Normalization Format Consistency
   * 
   * For any protocol data in various input formats, the Metric Aggregator SHALL
   * normalize all data to a common format with fields: protocol, tvlUsd, poolCount,
   * avgDepthUsd, timestamp.
   * 
   * Validates: Requirements 6.4
   */
  describe('Property 17: Data Normalization Format Consistency', () => {
    it('normalizes all data to common format with required fields', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvl: fc.integer({ min: 0, max: 1000000000 }),
              apy: fc.integer({ min: 0, max: 100 }),
              poolCount: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
              timestamp: fc.option(fc.constant(new Date().toISOString()), { nil: undefined }),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (rawYields: NormalizedYield[]) => {
            const mockYieldService: IYieldService = {
              getYieldData: async () => rawYields,
            };

            const aggregator = new MetricAggregator(mockYieldService);
            const result = await aggregator.aggregatePoolDepth();

            // Verify all protocols have required fields
            for (const protocol of result.protocols) {
              expect(protocol).toHaveProperty('protocol');
              expect(protocol).toHaveProperty('tvlUsd');
              expect(protocol).toHaveProperty('poolCount');
              expect(protocol).toHaveProperty('avgDepthUsd');
              expect(protocol).toHaveProperty('fetchedAt');

              // Verify field types
              expect(typeof protocol.protocol).toBe('string');
              expect(typeof protocol.tvlUsd).toBe('number');
              expect(typeof protocol.poolCount).toBe('number');
              expect(typeof protocol.avgDepthUsd).toBe('number');
              expect(typeof protocol.fetchedAt).toBe('string');

              // Verify values are valid
              expect(protocol.tvlUsd).toBeGreaterThanOrEqual(0);
              expect(protocol.poolCount).toBeGreaterThan(0);
              expect(protocol.avgDepthUsd).toBeGreaterThanOrEqual(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('calculates avgDepthUsd correctly from tvl and poolCount', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvl: fc.integer({ min: 1, max: 1000000000 }),
              apy: fc.integer({ min: 0, max: 100 }),
              poolCount: fc.integer({ min: 1, max: 100 }),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (rawYields: NormalizedYield[]) => {
            const mockYieldService: IYieldService = {
              getYieldData: async () => rawYields,
            };

            const aggregator = new MetricAggregator(mockYieldService);
            const result = await aggregator.aggregatePoolDepth();

            // Verify avgDepthUsd calculation
            for (let i = 0; i < result.protocols.length; i++) {
              const protocol = result.protocols[i];
              const rawYield = rawYields[i];
              const expectedAvgDepth = rawYield.tvl / rawYield.poolCount!;

              expect(Math.abs(protocol.avgDepthUsd - expectedAvgDepth)).toBeLessThan(0.01);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 23: Aggregation Round-Trip Preservation
   * 
   * For any valid pool depth and route data, aggregating the data then disaggregating
   * it SHALL preserve the original protocol TVL distribution within 1% tolerance.
   * 
   * Validates: Requirements 9.1
   */
  describe('Property 23: Aggregation Round-Trip Preservation', () => {
    it('preserves TVL distribution within 1% tolerance', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvl: fc.integer({ min: 1000, max: 1000000000 }),
              apy: fc.integer({ min: 0, max: 100 }),
              poolCount: fc.integer({ min: 1, max: 100 }),
            }),
            { minLength: 2, maxLength: 10 }
          ),
          async (rawYields: NormalizedYield[]) => {
            const mockYieldService: IYieldService = {
              getYieldData: async () => rawYields,
            };

            const aggregator = new MetricAggregator(mockYieldService);
            const result = await aggregator.aggregatePoolDepth();

            // Calculate original TVL distribution
            const originalTotalTvl = rawYields.reduce((sum, y) => sum + y.tvl, 0);
            const originalDistribution = rawYields.map((y) => y.tvl / originalTotalTvl);

            // Calculate aggregated TVL distribution
            const aggregatedTotalTvl = result.totalTvlUsd;
            const aggregatedDistribution = result.protocols.map(
              (p) => p.tvlUsd / aggregatedTotalTvl
            );

            // Verify distributions match within 1% tolerance
            for (let i = 0; i < originalDistribution.length; i++) {
              const diff = Math.abs(originalDistribution[i] - aggregatedDistribution[i]);
              expect(diff).toBeLessThan(0.01); // 1% tolerance
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('preserves total TVL exactly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvl: fc.integer({ min: 1, max: 1000000000 }),
              apy: fc.integer({ min: 0, max: 100 }),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (rawYields: NormalizedYield[]) => {
            const mockYieldService: IYieldService = {
              getYieldData: async () => rawYields,
            };

            const aggregator = new MetricAggregator(mockYieldService);
            const result = await aggregator.aggregatePoolDepth();

            const originalTotalTvl = rawYields.reduce((sum, y) => sum + y.tvl, 0);
            expect(result.totalTvlUsd).toBe(originalTotalTvl);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
