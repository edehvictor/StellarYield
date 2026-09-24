/**
 * Unit tests for FragmentationCalculator
 * 
 * These tests verify specific scenarios, edge cases, and error conditions.
 */

import { FragmentationCalculator } from '../../services/fragmentation/FragmentationCalculator';
import { ProtocolLiquidityData, FragmentationError } from '../../services/fragmentation/types';

describe('FragmentationCalculator - Unit Tests', () => {
  let calculator: FragmentationCalculator;
  const timestamp = new Date().toISOString();

  beforeEach(() => {
    calculator = new FragmentationCalculator();
  });

  describe('calculateHHI', () => {
    it('calculates HHI correctly for single protocol (monopoly)', () => {
      const protocols: ProtocolLiquidityData[] = [
        {
          protocol: 'Blend',
          tvlUsd: 10000000,
          poolCount: 50,
          avgDepthUsd: 200000,
          fetchedAt: timestamp,
        },
      ];

      const result = calculator.calculateHHI(protocols);

      // Single protocol = 100% market share = HHI of 10000
      expect(result.hhi).toBe(10000);
      expect(result.fragmentationScore).toBe(0); // No fragmentation
      expect(result.effectiveProtocolCount).toBe(1);
      expect(result.protocolShares.get('Blend')).toBe(100);
    });

    it('calculates HHI correctly for equal distribution', () => {
      const protocols: ProtocolLiquidityData[] = [
        {
          protocol: 'Blend',
          tvlUsd: 5000000,
          poolCount: 25,
          avgDepthUsd: 200000,
          fetchedAt: timestamp,
        },
        {
          protocol: 'Soroswap',
          tvlUsd: 5000000,
          poolCount: 25,
          avgDepthUsd: 200000,
          fetchedAt: timestamp,
        },
      ];

      const result = calculator.calculateHHI(protocols);

      // Two equal protocols = 50% each = HHI of 5000
      expect(result.hhi).toBe(5000);
      expect(result.fragmentationScore).toBe(50);
      expect(result.effectiveProtocolCount).toBe(2);
      expect(result.protocolShares.get('Blend')).toBe(50);
      expect(result.protocolShares.get('Soroswap')).toBe(50);
    });

    it('calculates HHI correctly for four equal protocols', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 2500000, poolCount: 10, avgDepthUsd: 250000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 2500000, poolCount: 10, avgDepthUsd: 250000, fetchedAt: timestamp },
        { protocol: 'DeFindex', tvlUsd: 2500000, poolCount: 10, avgDepthUsd: 250000, fetchedAt: timestamp },
        { protocol: 'Aquarius', tvlUsd: 2500000, poolCount: 10, avgDepthUsd: 250000, fetchedAt: timestamp },
      ];

      const result = calculator.calculateHHI(protocols);

      // Four equal protocols = 25% each = HHI of 2500
      expect(result.hhi).toBe(2500);
      expect(result.fragmentationScore).toBe(75);
      expect(result.effectiveProtocolCount).toBe(4);
    });

    it('throws error for empty protocols array', () => {
      expect(() => calculator.calculateHHI([])).toThrow(FragmentationError);
      expect(() => calculator.calculateHHI([])).toThrow('no protocol data provided');
    });

    it('throws error for zero total TVL', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 0, poolCount: 0, avgDepthUsd: 0, fetchedAt: timestamp },
      ];

      expect(() => calculator.calculateHHI(protocols)).toThrow(FragmentationError);
      expect(() => calculator.calculateHHI(protocols)).toThrow('total TVL is zero');
    });

    it('throws error for negative TVL', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: -1000000, poolCount: 10, avgDepthUsd: 100000, fetchedAt: timestamp },
      ];

      expect(() => calculator.calculateHHI(protocols)).toThrow(FragmentationError);
    });
  });

  describe('computeFragmentationScore', () => {
    it('returns 0 for HHI of 10000 (monopoly)', () => {
      const score = calculator.computeFragmentationScore(10000);
      expect(score).toBe(0);
    });

    it('returns 100 for HHI of 0 (perfect competition)', () => {
      const score = calculator.computeFragmentationScore(0);
      expect(score).toBe(100);
    });

    it('returns 50 for HHI of 5000', () => {
      const score = calculator.computeFragmentationScore(5000);
      expect(score).toBe(50);
    });

    it('throws error for HHI below 0', () => {
      expect(() => calculator.computeFragmentationScore(-1)).toThrow(FragmentationError);
    });

    it('throws error for HHI above 10000', () => {
      expect(() => calculator.computeFragmentationScore(10001)).toThrow(FragmentationError);
    });
  });

  describe('calculateEffectiveProtocolCount', () => {
    it('returns 1 for HHI of 10000 (monopoly)', () => {
      const count = calculator.calculateEffectiveProtocolCount(10000);
      expect(count).toBe(1);
    });

    it('returns 2 for HHI of 5000 (duopoly)', () => {
      const count = calculator.calculateEffectiveProtocolCount(5000);
      expect(count).toBe(2);
    });

    it('returns 4 for HHI of 2500', () => {
      const count = calculator.calculateEffectiveProtocolCount(2500);
      expect(count).toBe(4);
    });

    it('returns Infinity for HHI of 0 (perfect competition)', () => {
      const count = calculator.calculateEffectiveProtocolCount(0);
      expect(count).toBe(Infinity);
    });

    it('throws error for HHI below 0', () => {
      expect(() => calculator.calculateEffectiveProtocolCount(-1)).toThrow(FragmentationError);
    });

    it('throws error for HHI above 10000', () => {
      expect(() => calculator.calculateEffectiveProtocolCount(10001)).toThrow(FragmentationError);
    });
  });

  describe('estimateMultiProtocolRouting', () => {
    it('returns 0 for empty protocols array', () => {
      const routingPct = calculator.estimateMultiProtocolRouting([]);
      expect(routingPct).toBe(0);
    });

    it('returns 0 for single protocol', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10000000, poolCount: 50, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const routingPct = calculator.estimateMultiProtocolRouting(protocols);
      expect(routingPct).toBe(0);
    });

    it('returns high percentage for highly fragmented market', () => {
      // Four equal protocols = HHI of 2500 (highly competitive)
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 2500000, poolCount: 10, avgDepthUsd: 250000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 2500000, poolCount: 10, avgDepthUsd: 250000, fetchedAt: timestamp },
        { protocol: 'DeFindex', tvlUsd: 2500000, poolCount: 10, avgDepthUsd: 250000, fetchedAt: timestamp },
        { protocol: 'Aquarius', tvlUsd: 2500000, poolCount: 10, avgDepthUsd: 250000, fetchedAt: timestamp },
      ];

      const routingPct = calculator.estimateMultiProtocolRouting(protocols);
      expect(routingPct).toBeGreaterThanOrEqual(50); // Should be high for fragmented market
    });

    it('returns low percentage for concentrated market', () => {
      // One dominant protocol = HHI close to 10000
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 9000000, poolCount: 45, avgDepthUsd: 200000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 1000000, poolCount: 5, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const routingPct = calculator.estimateMultiProtocolRouting(protocols);
      expect(routingPct).toBeLessThan(30); // Should be low for concentrated market
    });

    it('returns value in valid range [0, 100]', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 6000000, poolCount: 30, avgDepthUsd: 200000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 4000000, poolCount: 20, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const routingPct = calculator.estimateMultiProtocolRouting(protocols);
      expect(routingPct).toBeGreaterThanOrEqual(0);
      expect(routingPct).toBeLessThanOrEqual(100);
    });
  });

  describe('degenerate liquidity edge cases (#817)', () => {
    it('excludes zero-liquidity pools from HHI calculation', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10_000_000, poolCount: 50, avgDepthUsd: 200000, fetchedAt: timestamp },
        { protocol: 'Ghost', tvlUsd: 0, poolCount: 0, avgDepthUsd: 0, fetchedAt: timestamp },
        { protocol: 'Empty', tvlUsd: 0, poolCount: 0, avgDepthUsd: 0, fetchedAt: timestamp },
      ];

      const result = calculator.calculateHHI(protocols);
      expect(result.hhi).toBe(10000);
      expect(result.fragmentationScore).toBe(0);
      expect(result.protocolShares.has('Ghost')).toBe(false);
    });

    it('handles extreme skew (99.9/0.1) with bounded output', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Dominant', tvlUsd: 9_990_000, poolCount: 45, avgDepthUsd: 200000, fetchedAt: timestamp },
        { protocol: 'Minor', tvlUsd: 10_000, poolCount: 5, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const result = calculator.calculateHHI(protocols);
      expect(result.hhi).toBeGreaterThan(9800);
      expect(result.fragmentationScore).toBeGreaterThanOrEqual(0);
      expect(result.fragmentationScore).toBeLessThanOrEqual(100);
      expect(result.effectiveProtocolCount).toBeGreaterThan(1);
      expect(result.effectiveProtocolCount).toBeLessThan(1.1);
    });

    it('handles highly dispersed inputs (20 equal protocols)', () => {
      const protocols: ProtocolLiquidityData[] = Array.from({ length: 20 }, (_, i) => ({
        protocol: `Protocol${i}`,
        tvlUsd: 1_000_000,
        poolCount: 5,
        avgDepthUsd: 200000,
        fetchedAt: timestamp,
      }));

      const result = calculator.calculateHHI(protocols);
      expect(result.hhi).toBeCloseTo(500, 0);
      expect(result.fragmentationScore).toBeCloseTo(95, 0);
      expect(result.effectiveProtocolCount).toBeCloseTo(20, 0);
    });

    it('produces identical results on repeated recomputation', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 4_000_000, poolCount: 20, avgDepthUsd: 200000, fetchedAt: timestamp },
        { protocol: 'Soroswap', tvlUsd: 3_000_000, poolCount: 15, avgDepthUsd: 200000, fetchedAt: timestamp },
        { protocol: 'DeFindex', tvlUsd: 3_000_000, poolCount: 15, avgDepthUsd: 200000, fetchedAt: timestamp },
      ];

      const first = calculator.calculateHHI(protocols);
      const second = calculator.calculateHHI(protocols);

      expect(second).toEqual(first);
    });

    it('throws for NaN TVL inputs', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: NaN, poolCount: 10, avgDepthUsd: 100000, fetchedAt: timestamp },
      ];

      expect(() => calculator.calculateHHI(protocols)).toThrow(FragmentationError);
    });

    it('throws when all pools have zero liquidity', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'A', tvlUsd: 0, poolCount: 0, avgDepthUsd: 0, fetchedAt: timestamp },
        { protocol: 'B', tvlUsd: 0, poolCount: 0, avgDepthUsd: 0, fetchedAt: timestamp },
      ];

      expect(() => calculator.calculateHHI(protocols)).toThrow('no protocols with positive liquidity');
    });

    it('zero-liquidity ghosts do not inflate routing percentage', () => {
      const protocols: ProtocolLiquidityData[] = [
        { protocol: 'Blend', tvlUsd: 10_000_000, poolCount: 50, avgDepthUsd: 200000, fetchedAt: timestamp },
        { protocol: 'Ghost1', tvlUsd: 0, poolCount: 0, avgDepthUsd: 0, fetchedAt: timestamp },
        { protocol: 'Ghost2', tvlUsd: 0, poolCount: 0, avgDepthUsd: 0, fetchedAt: timestamp },
      ];

      const routingPct = calculator.estimateMultiProtocolRouting(protocols);
      expect(routingPct).toBe(0);
    });
  });
});
