/**
 * Property-based tests for FragmentationCalculator
 * 
 * These tests verify universal correctness properties across all valid inputs
 * using the fast-check library for property-based testing.
 */

import fc from 'fast-check';
import { FragmentationCalculator } from '../../services/fragmentation/FragmentationCalculator';
import { ProtocolLiquidityData } from '../../services/fragmentation/types';

describe('FragmentationCalculator - Property Tests', () => {
  let calculator: FragmentationCalculator;

  beforeEach(() => {
    calculator = new FragmentationCalculator();
  });

  /**
   * Property 2: HHI Mathematical Correctness
   * 
   * For any TVL distribution across protocols, the calculated HHI
   * SHALL equal the sum of squared market shares.
   * 
   * Validates: Requirements 1.2, 9.4
   */
  describe('Property 2: HHI Mathematical Correctness', () => {
    it('calculates HHI correctly for all TVL distributions', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvlUsd: fc.integer({ min: 1, max: 1000000000 }),
              poolCount: fc.integer({ min: 1, max: 100 }),
              avgDepthUsd: fc.integer({ min: 0, max: 10000000 }),
              fetchedAt: fc.constant(new Date().toISOString()),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (protocols: ProtocolLiquidityData[]) => {
            const result = calculator.calculateHHI(protocols);

            // Calculate expected HHI manually
            const totalTvl = protocols.reduce((sum, p) => sum + p.tvlUsd, 0);
            const expectedHHI = protocols.reduce((sum, p) => {
              const share = (p.tvlUsd / totalTvl) * 100; // percentage points
              return sum + share * share;
            }, 0);

            // Allow small floating-point tolerance (0.01)
            expect(Math.abs(result.hhi - expectedHHI)).toBeLessThan(0.01);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 1: Score Range Validity
   * 
   * For any valid pool depth data, fragmentation score SHALL be in [0, 100].
   * 
   * Validates: Requirements 1.1, 2.1
   */
  describe('Property 1: Score Range Validity', () => {
    it('produces fragmentation scores in valid range [0, 100]', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvlUsd: fc.integer({ min: 1, max: 1000000000 }),
              poolCount: fc.integer({ min: 1, max: 100 }),
              avgDepthUsd: fc.integer({ min: 0, max: 10000000 }),
              fetchedAt: fc.constant(new Date().toISOString()),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (protocols: ProtocolLiquidityData[]) => {
            const result = calculator.calculateHHI(protocols);
            const score = calculator.computeFragmentationScore(result.hhi);

            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('produces fragmentation scores in valid range when computed directly from HHI', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 10000 }),
          (hhi: number) => {
            const score = calculator.computeFragmentationScore(hhi);

            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 3: Effective Protocol Count Relationship
   * 
   * For any valid HHI value, the effective protocol count SHALL equal
   * 10000/HHI (normalized), representing the equivalent number of equal-sized protocols.
   * 
   * Validates: Requirements 1.3
   */
  describe('Property 3: Effective Protocol Count Relationship', () => {
    it('calculates effective protocol count as 10000/HHI', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10000 }), // Avoid division by zero
          (hhi: number) => {
            const effectiveCount = calculator.calculateEffectiveProtocolCount(hhi);
            const expectedCount = 10000 / hhi;

            // Allow small floating-point tolerance
            expect(Math.abs(effectiveCount - expectedCount)).toBeLessThan(0.01);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('returns Infinity for HHI of 0 (perfect competition)', () => {
      const effectiveCount = calculator.calculateEffectiveProtocolCount(0);
      expect(effectiveCount).toBe(Infinity);
    });
  });

  /**
   * Property 4: Multi-Protocol Routing Percentage Range
   * 
   * For any route distribution data, the calculated percentage of trades
   * requiring multi-protocol routing SHALL be in the range [0, 100].
   * 
   * Validates: Requirements 1.4
   */
  describe('Property 4: Multi-Protocol Routing Percentage Range', () => {
    it('produces routing percentages in valid range [0, 100]', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvlUsd: fc.integer({ min: 1, max: 1000000000 }),
              poolCount: fc.integer({ min: 1, max: 100 }),
              avgDepthUsd: fc.integer({ min: 0, max: 10000000 }),
              fetchedAt: fc.constant(new Date().toISOString()),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (protocols: ProtocolLiquidityData[]) => {
            const routingPct = calculator.estimateMultiProtocolRouting(protocols);

            expect(routingPct).toBeGreaterThanOrEqual(0);
            expect(routingPct).toBeLessThanOrEqual(100);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 24: Fragmentation Score Monotonicity with Distribution Evenness
   * 
   * For any two TVL distributions where distribution A is more evenly spread
   * across protocols than distribution B, the fragmentation score for A SHALL
   * be greater than or equal to the score for B.
   * 
   * Validates: Requirements 9.2
   */
  describe('Property 24: Fragmentation Score Monotonicity', () => {
    it('produces higher scores for more evenly distributed liquidity', () => {
      // Test with specific examples that demonstrate monotonicity
      const timestamp = new Date().toISOString();

      // Scenario A: Even distribution (2 protocols with 50/50 split)
      const evenDistribution: ProtocolLiquidityData[] = [
        { protocol: 'A', tvlUsd: 1000000, poolCount: 10, avgDepthUsd: 100000, fetchedAt: timestamp },
        { protocol: 'B', tvlUsd: 1000000, poolCount: 10, avgDepthUsd: 100000, fetchedAt: timestamp },
      ];

      // Scenario B: Uneven distribution (2 protocols with 90/10 split)
      const unevenDistribution: ProtocolLiquidityData[] = [
        { protocol: 'A', tvlUsd: 1800000, poolCount: 10, avgDepthUsd: 180000, fetchedAt: timestamp },
        { protocol: 'B', tvlUsd: 200000, poolCount: 10, avgDepthUsd: 20000, fetchedAt: timestamp },
      ];

      const evenResult = calculator.calculateHHI(evenDistribution);
      const unevenResult = calculator.calculateHHI(unevenDistribution);

      const evenScore = calculator.computeFragmentationScore(evenResult.hhi);
      const unevenScore = calculator.computeFragmentationScore(unevenResult.hhi);

      // More even distribution should have higher fragmentation score
      expect(evenScore).toBeGreaterThan(unevenScore);
    });

    it('produces lower HHI for more evenly distributed liquidity', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 5 }),
          (numProtocols: number) => {
            const timestamp = new Date().toISOString();
            const totalTvl = 10000000;

            // Create even distribution
            const evenTvl = totalTvl / numProtocols;
            const evenDistribution: ProtocolLiquidityData[] = Array.from(
              { length: numProtocols },
              (_, i) => ({
                protocol: `Protocol${i}`,
                tvlUsd: evenTvl,
                poolCount: 10,
                avgDepthUsd: evenTvl / 10,
                fetchedAt: timestamp,
              })
            );

            // Create uneven distribution (one dominant protocol)
            const dominantTvl = totalTvl * 0.7;
            const remainingTvl = (totalTvl - dominantTvl) / (numProtocols - 1);
            const unevenDistribution: ProtocolLiquidityData[] = [
              {
                protocol: 'Dominant',
                tvlUsd: dominantTvl,
                poolCount: 10,
                avgDepthUsd: dominantTvl / 10,
                fetchedAt: timestamp,
              },
              ...Array.from({ length: numProtocols - 1 }, (_, i) => ({
                protocol: `Protocol${i}`,
                tvlUsd: remainingTvl,
                poolCount: 10,
                avgDepthUsd: remainingTvl / 10,
                fetchedAt: timestamp,
              })),
            ];

            const evenHHI = calculator.calculateHHI(evenDistribution).hhi;
            const unevenHHI = calculator.calculateHHI(unevenDistribution).hhi;

            // More even distribution should have lower HHI
            expect(evenHHI).toBeLessThan(unevenHHI);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
