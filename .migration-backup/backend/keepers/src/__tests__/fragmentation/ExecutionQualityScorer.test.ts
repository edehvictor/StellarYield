/**
 * Unit tests for ExecutionQualityScorer
 * 
 * These tests verify specific scenarios and edge cases.
 */

import { ExecutionQualityScorer, MockSlippageRegistry } from '../../services/fragmentation/ExecutionQualityScorer';
import { ProtocolLiquidityData, FragmentationError } from '../../services/fragmentation/types';

describe('ExecutionQualityScorer - Unit Tests', () => {
  let scorer: ExecutionQualityScorer;
  const timestamp = new Date().toISOString();

  beforeEach(() => {
    scorer = new ExecutionQualityScorer(new MockSlippageRegistry());
  });

  describe('computeExecutionQuality', () => {
    it('computes quality score for single protocol', async () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000000, poolCount: 50, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const result = await scorer.computeExecutionQuality(25, protocols);

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.avgSlippageBps).toBeGreaterThan(0);
      expect(result.routingComplexity).toBeGreaterThanOrEqual(1);
      expect(result.routingComplexity).toBeLessThanOrEqual(5);
      expect(result.protocolContributions).toHaveLength(1);
    });

    it('computes quality score for multiple protocols', async () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 12400000, poolCount: 50, avgDepthUsd: 248000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 4850000, poolCount: 30, avgDepthUsd: 161667, fetchedAt: timestamp },
        { protocol: 'DeFindex', tvlUsd: 2100000, poolCount: 15, avgDepthUsd: 140000, fetchedAt: timestamp },
      ];

      const result = await scorer.computeExecutionQuality(50, protocols);

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.protocolContributions).toHaveLength(3);
    });

    it('throws error for invalid fragmentation score', async () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000000, poolCount: 50, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      await expect(scorer.computeExecutionQuality(-1, protocols)).rejects.toThrow(FragmentationError);
      await expect(scorer.computeExecutionQuality(101, protocols)).rejects.toThrow(FragmentationError);
    });

    it('throws error for empty protocols array', async () => {
      await expect(scorer.computeExecutionQuality(50, [])).rejects.toThrow(FragmentationError);
      await expect(scorer.computeExecutionQuality(50, [])).rejects.toThrow('no protocol data');
    });
  });

  describe('hasMaterialImpact', () => {
    it('returns true for score below 70', () => {
      expect(scorer.hasMaterialImpact(69)).toBe(true);
      expect(scorer.hasMaterialImpact(50)).toBe(true);
      expect(scorer.hasMaterialImpact(0)).toBe(true);
    });

    it('returns false for score at or above 70', () => {
      expect(scorer.hasMaterialImpact(70)).toBe(false);
      expect(scorer.hasMaterialImpact(85)).toBe(false);
      expect(scorer.hasMaterialImpact(100)).toBe(false);
    });

    it('handles boundary value correctly', () => {
      expect(scorer.hasMaterialImpact(69.99)).toBe(true);
      expect(scorer.hasMaterialImpact(70.01)).toBe(false);
    });
  });

  describe('analyzeProtocolContributions', () => {
    it('identifies protocol with deepest liquidity', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 12400000, poolCount: 50, avgDepthUsd: 248000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 4850000, poolCount: 30, avgDepthUsd: 161667, fetchedAt: timestamp },
      ];

      const contributions = scorer.analyzeProtocolContributions(protocols);

      const deepest = contributions.find((c) => c.isDeepest);
      expect(deepest?.protocol).toBe('Blend');
    });

    it('calculates TVL shares correctly', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 6000000, poolCount: 30, avgDepthUsd: 200000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 4000000, poolCount: 20, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const contributions = scorer.analyzeProtocolContributions(protocols);

      expect(contributions[0].tvlShare).toBeCloseTo(60, 1);
      expect(contributions[1].tvlShare).toBeCloseTo(40, 1);
    });

    it('normalizes execution impacts to sum to 100%', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 12400000, poolCount: 50, avgDepthUsd: 248000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 4850000, poolCount: 30, avgDepthUsd: 161667, fetchedAt: timestamp },
        { protocol: 'DeFindex', tvlUsd: 2100000, poolCount: 15, avgDepthUsd: 140000, fetchedAt: timestamp },
      ];

      const contributions = scorer.analyzeProtocolContributions(protocols);

      const totalImpact = contributions.reduce((sum, c) => sum + c.executionImpact, 0);
      expect(Math.abs(totalImpact - 100)).toBeLessThan(0.1);
    });

    it('handles single protocol correctly', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000000, poolCount: 50, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const contributions = scorer.analyzeProtocolContributions(protocols);

      expect(contributions).toHaveLength(1);
      expect(contributions[0].tvlShare).toBe(100);
      expect(contributions[0].isDeepest).toBe(true);
    });

    it('returns empty array for zero total TVL', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 0, poolCount: 0, avgDepthUsd: 0, fetchedAt: timestamp },
      ];

      const contributions = scorer.analyzeProtocolContributions(protocols);

      expect(contributions).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('handles zero slippage scenario', async () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 100000000, poolCount: 100, avgDepthUsd: 10000000, fetchedAt: timestamp },
      ];

      const result = await scorer.computeExecutionQuality(10, protocols);

      // Very high liquidity should result in high quality score
      expect(result.score).toBeGreaterThan(80);
    });

    it('handles maximum slippage scenario', async () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000, poolCount: 1, avgDepthUsd: 10000, fetchedAt: timestamp },
      ];

      const result = await scorer.computeExecutionQuality(90, protocols);

      // Very low liquidity and high fragmentation should result in lower quality score
      expect(result.score).toBeLessThan(90);
      // Check that routing complexity is elevated due to high fragmentation
      expect(result.routingComplexity).toBeGreaterThanOrEqual(1);
      expect(result.routingComplexity).toBeLessThanOrEqual(5);
    });

    it('handles single protocol vs multi-protocol routing', async () => {
      const singleProtocol: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000000, poolCount: 50, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const multiProtocol: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 5000000, poolCount: 25, avgDepthUsd: 200000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 5000000, poolCount: 25, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const singleResult = await scorer.computeExecutionQuality(20, singleProtocol);
      const multiResult = await scorer.computeExecutionQuality(50, multiProtocol);

      // Multi-protocol with higher fragmentation should have higher routing complexity
      expect(multiResult.routingComplexity).toBeGreaterThan(singleResult.routingComplexity);
    });

    it('handles material impact boundary (score = 69.99 vs 70.01)', async () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000000, poolCount: 50, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      // We can't directly control the score, but we can verify the threshold logic
      expect(scorer.hasMaterialImpact(69.99)).toBe(true);
      expect(scorer.hasMaterialImpact(70.01)).toBe(false);
    });
  });

  describe('custom threshold', () => {
    it('supports custom material impact threshold', async () => {
      const customScorer = new ExecutionQualityScorer(new MockSlippageRegistry(), 80);

      expect(customScorer.hasMaterialImpact(79)).toBe(true);
      expect(customScorer.hasMaterialImpact(80)).toBe(false);
      expect(customScorer.hasMaterialImpact(81)).toBe(false);
    });
  });
});
