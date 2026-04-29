/**
 * ExecutionQualityScorer
 * 
 * Analyzes slippage impact and routing complexity to compute execution quality scores.
 * Identifies material impact thresholds and provides protocol-level contribution breakdown.
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import {
  ProtocolLiquidityData,
  ExecutionQualityResult,
  ProtocolContribution,
  FragmentationError,
} from './types';

/**
 * Interface for slippage estimates
 */
export interface SlippageEstimate {
  protocol: string;
  estimatedSlippageBps: number;
  liquidityDepthUsd: number;
}

/**
 * Interface for slippage registry dependency
 */
export interface ISlippageRegistry {
  getSlippageEstimate(protocol: string, tradeSize: number): Promise<SlippageEstimate>;
}

/**
 * Mock slippage registry for testing (can be replaced with real implementation)
 */
export class MockSlippageRegistry implements ISlippageRegistry {
  async getSlippageEstimate(protocol: string, tradeSize: number): Promise<SlippageEstimate> {
    // Simple mock: estimate slippage based on protocol name
    const slippageMap: Record<string, number> = {
      'Blend': 10,
      'Soroswap': 15,
      'DeFindex': 20,
      'Aquarius': 25,
    };
    
    const baseSlippage = slippageMap[protocol] || 20;

    return {
      protocol,
      estimatedSlippageBps: baseSlippage,
      liquidityDepthUsd: tradeSize * 100,
    };
  }
}

export class ExecutionQualityScorer {
  private slippageRegistry: ISlippageRegistry;
  private materialImpactThreshold: number;

  constructor(
    slippageRegistry: ISlippageRegistry = new MockSlippageRegistry(),
    materialImpactThreshold: number = 70
  ) {
    this.slippageRegistry = slippageRegistry;
    this.materialImpactThreshold = materialImpactThreshold;
  }

  /**
   * Compute execution quality score based on fragmentation and slippage
   * 
   * Score = 100 - (slippage_impact * 0.6 + routing_complexity * 0.4)
   * 
   * @param fragmentationScore - Fragmentation score (0-100)
   * @param protocols - Protocol liquidity data
   * @returns Execution quality result with score and breakdown
   */
  async computeExecutionQuality(
    fragmentationScore: number,
    protocols: ProtocolLiquidityData[]
  ): Promise<ExecutionQualityResult> {
    if (fragmentationScore < 0 || fragmentationScore > 100) {
      throw new FragmentationError(
        `Invalid fragmentation score: ${fragmentationScore}. Must be between 0 and 100`,
        'INVALID_FRAGMENTATION_SCORE',
        { fragmentationScore }
      );
    }

    if (!protocols || protocols.length === 0) {
      throw new FragmentationError(
        'Cannot compute execution quality: no protocol data provided',
        'NO_PROTOCOL_DATA'
      );
    }

    // Validate protocol data
    for (const protocol of protocols) {
      if (typeof protocol.tvlUsd !== 'number' || isNaN(protocol.tvlUsd)) {
        throw new FragmentationError(
          `Invalid TVL for protocol ${protocol.protocol}`,
          'INVALID_PROTOCOL_DATA',
          { protocol: protocol.protocol, tvlUsd: protocol.tvlUsd }
        );
      }
      if (typeof protocol.avgDepthUsd !== 'number' || isNaN(protocol.avgDepthUsd)) {
        throw new FragmentationError(
          `Invalid avgDepthUsd for protocol ${protocol.protocol}`,
          'INVALID_PROTOCOL_DATA',
          { protocol: protocol.protocol, avgDepthUsd: protocol.avgDepthUsd }
        );
      }
    }

    // Calculate average slippage across protocols
    const avgSlippageBps = await this.calculateAverageSlippage(protocols);

    // Calculate routing complexity (1-5 scale)
    const routingComplexity = this.calculateRoutingComplexity(fragmentationScore, protocols);

    // Compute slippage impact (0-100 scale)
    // Higher slippage = higher impact = lower quality
    const slippageImpact = Math.min(100, (avgSlippageBps / 100) * 100);

    // Compute routing complexity impact (0-100 scale)
    const routingImpact = (routingComplexity / 5) * 100;

    // Calculate execution quality score
    // Score = 100 - (slippage_impact * 0.6 + routing_complexity * 0.4)
    const score = Math.max(
      0,
      Math.min(100, 100 - (slippageImpact * 0.6 + routingImpact * 0.4))
    );

    // Analyze protocol contributions
    const protocolContributions = this.analyzeProtocolContributions(protocols);

    // Determine material impact
    const materialImpact = this.hasMaterialImpact(score);

    return {
      score,
      materialImpact,
      avgSlippageBps,
      routingComplexity,
      protocolContributions,
    };
  }

  /**
   * Calculate average slippage across protocols
   * 
   * @param protocols - Protocol liquidity data
   * @returns Average slippage in basis points
   */
  private async calculateAverageSlippage(
    protocols: ProtocolLiquidityData[]
  ): Promise<number> {
    const typicalTradeSize = 10000; // $10k typical trade

    try {
      const slippageEstimates = await Promise.all(
        protocols.map((p) => this.slippageRegistry.getSlippageEstimate(p.protocol, typicalTradeSize))
      );

      const totalSlippage = slippageEstimates.reduce(
        (sum, est) => sum + est.estimatedSlippageBps,
        0
      );

      return totalSlippage / slippageEstimates.length;
    } catch (error) {
      // If slippage data unavailable, estimate based on liquidity depth
      return this.estimateSlippageFromDepth(protocols);
    }
  }

  /**
   * Estimate slippage from liquidity depth when slippage registry unavailable
   * 
   * @param protocols - Protocol liquidity data
   * @returns Estimated average slippage in basis points
   */
  private estimateSlippageFromDepth(protocols: ProtocolLiquidityData[]): number {
    // Simple heuristic: lower depth = higher slippage
    const avgDepth = protocols.reduce((sum, p) => sum + p.avgDepthUsd, 0) / protocols.length;

    // Estimate slippage based on depth
    // High depth (>$1M) = low slippage (~10 bps)
    // Medium depth ($100k-$1M) = medium slippage (~25 bps)
    // Low depth (<$100k) = high slippage (~50 bps)
    if (avgDepth > 1000000) {
      return 10;
    } else if (avgDepth > 100000) {
      return 25;
    } else {
      return 50;
    }
  }

  /**
   * Calculate routing complexity based on fragmentation and protocol count
   * 
   * @param fragmentationScore - Fragmentation score (0-100)
   * @param protocols - Protocol liquidity data
   * @returns Routing complexity (1-5 scale)
   */
  private calculateRoutingComplexity(
    fragmentationScore: number,
    protocols: ProtocolLiquidityData[]
  ): number {
    // Base complexity on protocol count
    const protocolCount = protocols.length;

    // Adjust for fragmentation level
    // Low fragmentation (score < 30) = simple routing (1-2)
    // Medium fragmentation (30-60) = moderate routing (2-3)
    // High fragmentation (> 60) = complex routing (3-5)

    let baseComplexity: number;

    if (fragmentationScore < 30) {
      // Low fragmentation - simple routing
      baseComplexity = 1 + (protocolCount > 1 ? 0.5 : 0);
    } else if (fragmentationScore <= 60) {
      // Medium fragmentation - moderate routing
      baseComplexity = 2 + Math.min(1, (protocolCount - 2) * 0.3);
    } else {
      // High fragmentation - complex routing
      baseComplexity = 3 + Math.min(2, (protocolCount - 2) * 0.5);
    }

    // Ensure result is in 1-5 range
    return Math.max(1, Math.min(5, baseComplexity));
  }

  /**
   * Analyze which protocols contribute most to quality degradation
   * 
   * @param protocols - Protocol liquidity data
   * @returns Protocol contribution breakdown
   */
  analyzeProtocolContributions(
    protocols: ProtocolLiquidityData[]
  ): ProtocolContribution[] {
    const totalTvl = protocols.reduce((sum, p) => sum + p.tvlUsd, 0);

    if (totalTvl === 0 || protocols.length === 0) {
      return [];
    }

    // Find protocol with deepest liquidity (highest TVL)
    let deepestProtocol = protocols[0];
    for (const protocol of protocols) {
      if (protocol.tvlUsd > deepestProtocol.tvlUsd) {
        deepestProtocol = protocol;
      }
    }

    // Calculate contributions
    const contributions: ProtocolContribution[] = [];
    
    for (const protocol of protocols) {
      const tvlShare = (protocol.tvlUsd / totalTvl) * 100;

      // Execution impact: protocols with lower depth contribute more to degradation
      // Inverse relationship: lower depth = higher impact
      const depthScore = deepestProtocol.avgDepthUsd > 0 
        ? protocol.avgDepthUsd / deepestProtocol.avgDepthUsd 
        : 1;
      const executionImpact = (1 - depthScore) * tvlShare;

      contributions.push({
        protocol: protocol.protocol,
        tvlShare,
        executionImpact,
        isDeepest: protocol.protocol === deepestProtocol.protocol,
      });
    }

    // Normalize execution impacts to sum to 100%
    const totalImpact = contributions.reduce((sum, c) => sum + c.executionImpact, 0);

    if (totalImpact > 0) {
      for (const contribution of contributions) {
        contribution.executionImpact = (contribution.executionImpact / totalImpact) * 100;
      }
    } else {
      // If all protocols have same depth, distribute impact equally
      const equalImpact = 100 / contributions.length;
      for (const contribution of contributions) {
        contribution.executionImpact = equalImpact;
      }
    }

    return contributions;
  }

  /**
   * Determine if fragmentation has material impact on execution
   * 
   * @param executionQuality - Execution quality score (0-100)
   * @returns True if score is below material impact threshold
   */
  hasMaterialImpact(executionQuality: number): boolean {
    return executionQuality < this.materialImpactThreshold;
  }
}
