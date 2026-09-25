/**
 * Type definitions for Protocol Liquidity Fragmentation Analyzer
 * 
 * This module defines the core types used throughout the fragmentation analysis system.
 */

/**
 * Fragmentation category labels
 */
export type FragmentationCategory = 'Low' | 'Medium' | 'High';

/**
 * Protocol liquidity snapshot data
 */
export interface ProtocolLiquidityData {
  protocol: string;
  tvlUsd: number;
  poolCount: number;
  avgDepthUsd: number;
  fetchedAt: string;
}

/**
 * Complete fragmentation metrics response
 */
export interface FragmentationMetrics {
  fragmentationScore: number;        // 0-100 scale
  hhi: number;                        // Herfindahl-Hirschman Index
  effectiveProtocolCount: number;    // 1/HHI (normalized)
  multiProtocolRoutingPct: number;   // Percentage of trades requiring multi-protocol routing
  executionQualityScore: number;     // 0-100 scale
  materialImpact: boolean;           // True if execution quality < 70
  category: FragmentationCategory;
  categoryDescription: string;
  protocolBreakdown: ProtocolContribution[];
  dataCompleteness: DataCompletenessStatus;
  timestamp: string;
  nextUpdateAt: string;
}

/**
 * Protocol contribution to execution quality
 */
export interface ProtocolContribution {
  protocol: string;
  tvlShare: number;              // Percentage of total TVL
  executionImpact: number;       // Contribution to quality degradation
  isDeepest: boolean;            // True if this protocol has deepest liquidity
}

/**
 * Data completeness status indicators
 */
export interface DataCompletenessStatus {
  poolDepthAvailable: boolean;
  routeDataAvailable: boolean;
  missingProtocols: string[];
  isStale: boolean;
  staleSince?: string;
}

/**
 * HHI calculation result
 */
export interface HHICalculationResult {
  hhi: number;
  effectiveProtocolCount: number;
  fragmentationScore: number;
  protocolShares: Map<string, number>;
}

/**
 * Execution quality calculation result
 */
export interface ExecutionQualityResult {
  score: number;                    // 0-100 scale
  materialImpact: boolean;          // True if score < 70
  avgSlippageBps: number;          // Average slippage in basis points
  routingComplexity: number;        // 1-5 scale
  protocolContributions: ProtocolContribution[];
}

/**
 * Aggregated liquidity data from all protocols
 */
export interface AggregatedLiquidityData {
  protocols: ProtocolLiquidityData[];
  totalTvlUsd: number;
  timestamp: string;
  dataCompleteness: DataCompletenessStatus;
}

/**
 * Category label with visual indicators
 */
export interface CategoryLabel {
  category: FragmentationCategory;
  description: string;
  color: string;
  icon: string;
  tradingImplication: string;
}

/**
 * Routing recommendation
 */
export interface RoutingRecommendation {
  strategy: 'single-protocol' | 'multi-protocol';
  deepestProtocol: string;
  alternativeSuggestions: string[];
  reasoning: string;
}

/**
 * Fragmentation configuration
 */
export interface FragmentationConfig {
  pollingIntervalMs: number;          // Default: 120000 (2 minutes)
  cacheTtlSeconds: number;            // Default: 300 (5 minutes)
  materialImpactThreshold: number;    // Default: 70
  lowFragmentationThreshold: number;  // Default: 30
  highFragmentationThreshold: number; // Default: 60
}

/**
 * TVL distribution across protocols
 */
export interface TVLDistribution {
  totalTvl: number;
  protocolShares: Map<string, number>;  // protocol -> percentage
}

/**
 * Slippage estimate for a protocol
 */
export interface SlippageEstimate {
  protocol: string;
  estimatedSlippageBps: number;
  liquidityDepthUsd: number;
}

/**
 * Error types for fragmentation service
 */
export class FragmentationError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'FragmentationError';
  }
}
