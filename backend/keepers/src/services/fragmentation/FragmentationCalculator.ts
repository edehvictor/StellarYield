/**
 * FragmentationCalculator
 * 
 * Calculates liquidity fragmentation metrics using the Herfindahl-Hirschman Index (HHI).
 * The HHI measures market concentration by summing the squares of market shares.
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */

import {
  ProtocolLiquidityData,
  HHICalculationResult,
  FragmentationError,
} from './types';

export class FragmentationCalculator {
  /**
   * Calculate Herfindahl-Hirschman Index from TVL distribution
   * 
   * HHI = Σ(market_share_i)^2 where market_share is in percentage points
   * Range: 0 (perfect competition) to 10,000 (monopoly)
   * 
   * @param protocols - Array of protocol liquidity data
   * @returns HHI calculation result with derived metrics
   * @throws FragmentationError if protocols array is empty or has invalid data
   */
  calculateHHI(protocols: ProtocolLiquidityData[]): HHICalculationResult {
    if (!protocols || protocols.length === 0) {
      throw new FragmentationError(
        'Cannot calculate HHI: no protocol data provided',
        'NO_PROTOCOL_DATA'
      );
    }

    // Calculate total TVL
    const totalTvl = protocols.reduce((sum, p) => sum + p.tvlUsd, 0);

    if (totalTvl <= 0) {
      throw new FragmentationError(
        'Cannot calculate HHI: total TVL is zero or negative',
        'INVALID_TVL',
        { totalTvl }
      );
    }

    // Calculate market shares and HHI
    const protocolShares = new Map<string, number>();
    let hhi = 0;

    for (const protocol of protocols) {
      if (protocol.tvlUsd < 0) {
        throw new FragmentationError(
          `Invalid TVL for protocol ${protocol.protocol}: ${protocol.tvlUsd}`,
          'NEGATIVE_TVL',
          { protocol: protocol.protocol, tvl: protocol.tvlUsd }
        );
      }

      // Market share in percentage points (0-100)
      const sharePercentage = (protocol.tvlUsd / totalTvl) * 100;
      protocolShares.set(protocol.protocol, sharePercentage);

      // HHI is sum of squared market shares
      hhi += sharePercentage * sharePercentage;
    }

    // Calculate derived metrics
    const fragmentationScore = this.computeFragmentationScore(hhi);
    const effectiveProtocolCount = this.calculateEffectiveProtocolCount(hhi);

    return {
      hhi,
      effectiveProtocolCount,
      fragmentationScore,
      protocolShares,
    };
  }

  /**
   * Convert HHI to 0-100 fragmentation score
   * 
   * Score = 100 * (1 - HHI/10000)
   * Higher score = more fragmentation (more evenly distributed)
   * 
   * @param hhi - Herfindahl-Hirschman Index (0-10000)
   * @returns Fragmentation score (0-100)
   */
  computeFragmentationScore(hhi: number): number {
    if (hhi < 0 || hhi > 10000) {
      throw new FragmentationError(
        `Invalid HHI value: ${hhi}. Must be between 0 and 10000`,
        'INVALID_HHI',
        { hhi }
      );
    }

    // Convert HHI to 0-100 scale
    // HHI of 10000 (monopoly) -> score of 0 (no fragmentation)
    // HHI of 0 (perfect competition) -> score of 100 (maximum fragmentation)
    const score = 100 * (1 - hhi / 10000);

    // Ensure score is in valid range (handle floating point precision)
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate effective number of protocols
   * 
   * Effective count = 10000 / HHI
   * Represents the equivalent number of equal-sized protocols
   * 
   * @param hhi - Herfindahl-Hirschman Index (0-10000)
   * @returns Effective protocol count
   */
  calculateEffectiveProtocolCount(hhi: number): number {
    if (hhi < 0 || hhi > 10000) {
      throw new FragmentationError(
        `Invalid HHI value: ${hhi}. Must be between 0 and 10000`,
        'INVALID_HHI',
        { hhi }
      );
    }

    if (hhi === 0) {
      // Perfect competition - infinite effective protocols
      return Infinity;
    }

    // Effective count = 10000 / HHI
    return 10000 / hhi;
  }

  /**
   * Estimate multi-protocol routing percentage
   * 
   * Based on liquidity distribution and typical trade sizes.
   * More fragmented markets require more multi-protocol routing.
   * 
   * @param protocols - Array of protocol liquidity data
   * @returns Percentage of trades requiring multi-protocol routing (0-100)
   */
  estimateMultiProtocolRouting(protocols: ProtocolLiquidityData[]): number {
    if (!protocols || protocols.length === 0) {
      return 0;
    }

    if (protocols.length === 1) {
      // Only one protocol - no multi-protocol routing possible
      return 0;
    }

    // Calculate HHI to determine fragmentation level
    const { hhi } = this.calculateHHI(protocols);

    // Estimate routing complexity based on HHI
    // Lower HHI (more concentration) -> less multi-protocol routing
    // Higher HHI (more fragmentation) -> more multi-protocol routing
    
    // HHI ranges:
    // 0-1500: Highly competitive (80-100% multi-protocol)
    // 1500-2500: Moderately competitive (50-80% multi-protocol)
    // 2500-5000: Moderately concentrated (20-50% multi-protocol)
    // 5000-10000: Highly concentrated (0-20% multi-protocol)

    let routingPct: number;

    if (hhi < 1500) {
      // Highly fragmented - most trades need multi-protocol routing
      routingPct = 80 + (1500 - hhi) / 1500 * 20;
    } else if (hhi < 2500) {
      // Moderately fragmented
      routingPct = 50 + (2500 - hhi) / 1000 * 30;
    } else if (hhi < 5000) {
      // Moderately concentrated
      routingPct = 20 + (5000 - hhi) / 2500 * 30;
    } else {
      // Highly concentrated - most trades can use single protocol
      routingPct = (10000 - hhi) / 5000 * 20;
    }

    // Ensure result is in valid range
    return Math.max(0, Math.min(100, routingPct));
  }
}
