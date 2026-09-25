/**
 * Property-based tests for ExecutionQualityScorer
 * 
 * These tests verify universal correctness properties for execution quality scoring.
 */

import fc from 'fast-check';
import { ExecutionQualityScorer, MockSlippageRegistry } from '../../services/fragmentation/ExecutionQualityScorer';
import { ProtocolLiquidityData } from '../../services/fragmentation/types';

describe('ExecutionQualityScorer - Property Tests', () => {
  let scorer: ExecutionQualityScorer;

  beforeEach(() => {
    scorer = new ExecutionQualityScorer(new MockSlippageRegistry());
  });

  /**
   * Property 6: Slippage Impact Monotonicity
   * 
   * For any two fragmentation scenarios where scenario A has higher average slippage
   * than scenario B (all else equal), the execution quality score for A SHALL be
   * less than or equal to the score for B.
   * 
   * Validates: Requirements 2.2
   */
  describe('Property 6: Slippage Impact Monotonicity', () => {
    it('produces lower quality scores for higher slippage', async () => {
      // Test with specific scenarios
      const timestamp = new Date().toISOString();

      // Scenario A: High depth (low slippage)
      const lowSlippageProtocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000000, poolCount: 50, avgDepthUsd: 2000000, fetchedAt: timestamp },
      ];

      // Scenario B: Low depth (high slippage)
      const highSlippageProtocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000000, poolCount: 50, avgDepthUsd: 50000, fetchedAt: timestamp },
      ];

      const lowSlippageResult = await scorer.computeExecutionQuality(50, lowSlippageProtocols);
      const highSlippageResult = await scorer.computeExecutionQuality(50, highSlippageProtocols);

      // Higher slippage should result in lower quality score
      expect(highSlippageResult.score).toBeLessThanOrEqual(lowSlippageResult.score);
    });
  });

  /**
   * Property 7: Routing Complexity Impact Monotonicity
   * 
   * For any two fragmentation scenarios where scenario A has higher routing complexity
   * than scenario B (all else equal), the execution quality score for A SHALL be
   * less than or equal to the score for B.
   * 
   * Validates: Requirements 2.3
   */
  describe('Property 7: Routing Complexity Impact Monotonicity', () => {
    it('produces lower quality scores for higher routing complexity', async () => {
      const timestamp = new Date().toISOString();

      // Scenario A: Low fragmentation (simple routing)
      const lowFragmentation = 20;
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000000, poolCount: 50, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      // Scenario B: High fragmentation (complex routing)
      const highFragmentation = 80;

      const lowComplexityResult = await scorer.computeExecutionQuality(lowFragmentation, protocols);
      const highComplexityResult = await scorer.computeExecutionQuality(highFragmentation, protocols);

      // Higher routing complexity should result in lower quality score
      expect(highComplexityResult.score).toBeLessThanOrEqual(lowComplexityResult.score);
    });
  });

  /**
   * Property 8: Material Impact Threshold Consistency
   * 
   * For any execution quality score, the material impact flag SHALL be true
   * if and only if the score is less than 70.
   * 
   * Validates: Requirements 2.4
   */
  describe('Property 8: Material Impact Threshold Consistency', () => {
    it('sets material impact flag correctly based on threshold', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 100 }),
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvlUsd: fc.integer({ min: 1000, max: 100000000 }),
              poolCount: fc.integer({ min: 1, max: 100 }),
              avgDepthUsd: fc.integer({ min: 1000, max: 10000000 }),
              fetchedAt: fc.constant(new Date().toISOString()),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          async (fragmentationScore: number, protocols: ProtocolLiquidityData[]) => {
            const result = await scorer.computeExecutionQuality(fragmentationScore, protocols);

            // Material impact should be true iff score < 70
            if (result.score < 70) {
              expect(result.materialImpact).toBe(true);
            } else {
              expect(result.materialImpact).toBe(false);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 9: Protocol Contribution Sum
   * 
   * For any execution quality breakdown, the sum of all protocol contributions
   * to quality degradation SHALL equal 100% (within 0.1% tolerance).
   * 
   * Validates: Requirements 2.5
   */
  describe('Property 9: Protocol Contribution Sum', () => {
    it('protocol contributions sum to 100% within tolerance', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 100 }),
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvlUsd: fc.integer({ min: 1000, max: 100000000 }),
              poolCount: fc.integer({ min: 1, max: 100 }),
              avgDepthUsd: fc.integer({ min: 1000, max: 10000000 }),
              fetchedAt: fc.constant(new Date().toISOString()),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (fragmentationScore: number, protocols: ProtocolLiquidityData[]) => {
            const result = await scorer.computeExecutionQuality(fragmentationScore, protocols);

            // Sum all execution impacts
            const totalImpact = result.protocolContributions.reduce(
              (sum, c) => sum + c.executionImpact,
              0
            );

            // Should sum to 100% within 0.1% tolerance
            expect(Math.abs(totalImpact - 100)).toBeLessThan(0.1);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('TVL shares sum to 100% within tolerance', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 100 }),
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1 }),
              tvlUsd: fc.integer({ min: 1000, max: 100000000 }),
              poolCount: fc.integer({ min: 1, max: 100 }),
              avgDepthUsd: fc.integer({ min: 1000, max: 10000000 }),
              fetchedAt: fc.constant(new Date().toISOString()),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (fragmentationScore: number, protocols: ProtocolLiquidityData[]) => {
            const result = await scorer.computeExecutionQuality(fragmentationScore, protocols);

            // Sum all TVL shares
            const totalShare = result.protocolContributions.reduce(
              (sum, c) => sum + c.tvlShare,
              0
            );

            // Should sum to 100% within 0.1% tolerance
            expect(Math.abs(totalShare - 100)).toBeLessThan(0.1);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Additional property: Score range validity
   * 
   * Execution quality score should always be in [0, 100] range.
   */
  describe('Score Range Validity', () => {
    it('produces scores in valid range [0, 100]', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 100 }),
          fc.array(
            fc.record({
              protocol: fc.string({ minLength: 1, maxLength: 20 }).filter(s => {
                // Filter out JavaScript reserved words and Object prototype properties
                const reserved = ['valueOf', 'toString', 'constructor', 'hasOwnProperty', '__proto__'];
                return !reserved.includes(s);
              }),
              tvlUsd: fc.integer({ min: 1000, max: 100000000 }),
              poolCount: fc.integer({ min: 1, max: 100 }),
              avgDepthUsd: fc.integer({ min: 1000, max: 10000000 }),
              fetchedAt: fc.constant(new Date().toISOString()),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (fragmentationScore: number, protocols: ProtocolLiquidityData[]) => {
            const result = await scorer.computeExecutionQuality(fragmentationScore, protocols);

            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(100);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
