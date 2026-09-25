/**
 * FragmentationService
 * 
 * Orchestrates all fragmentation analysis components to provide complete
 * fragmentation metrics with caching, routing recommendations, and graceful degradation.
 * 
 * Requirements: 3.1, 3.2, 8.1, 8.2, 8.3, 8.4
 */

import NodeCache from 'node-cache';
import {
  FragmentationMetrics,
  RoutingRecommendation,
  FragmentationError,
  FragmentationConfig,
} from './types';
import { MetricAggregator } from './MetricAggregator';
import { FragmentationCalculator } from './FragmentationCalculator';
import { ExecutionQualityScorer } from './ExecutionQualityScorer';
import { ThresholdLabeler } from './ThresholdLabeler';

export class FragmentationService {
  private cache: NodeCache;
  private metricAggregator: MetricAggregator;
  private fragmentationCalculator: FragmentationCalculator;
  private executionQualityScorer: ExecutionQualityScorer;
  private thresholdLabeler: ThresholdLabeler;
  private config: FragmentationConfig;

  constructor(
    metricAggregator: MetricAggregator,
    fragmentationCalculator: FragmentationCalculator,
    executionQualityScorer: ExecutionQualityScorer,
    thresholdLabeler: ThresholdLabeler,
    config?: Partial<FragmentationConfig>
  ) {
    this.metricAggregator = metricAggregator;
    this.fragmentationCalculator = fragmentationCalculator;
    this.executionQualityScorer = executionQualityScorer;
    this.thresholdLabeler = thresholdLabeler;

    // Merge provided config with defaults
    this.config = {
      pollingIntervalMs: config?.pollingIntervalMs ?? 120000, // 2 minutes
      cacheTtlSeconds: config?.cacheTtlSeconds ?? 300, // 5 minutes
      materialImpactThreshold: config?.materialImpactThreshold ?? 70,
      lowFragmentationThreshold: config?.lowFragmentationThreshold ?? 30,
      highFragmentationThreshold: config?.highFragmentationThreshold ?? 60,
    };

    // Initialize cache with configured TTL
    this.cache = new NodeCache({
      stdTTL: this.config.cacheTtlSeconds,
      checkperiod: 60, // Check for expired keys every 60 seconds
    });
  }

  /**
   * Get current fragmentation metrics with cache support
   * Returns cached data if fresh (<5 minutes), otherwise recalculates
   * 
   * @returns Complete fragmentation metrics
   */
  async getFragmentationMetrics(): Promise<FragmentationMetrics> {
    const cacheKey = 'fragmentation_metrics';

    // Check cache first
    const cachedMetrics = this.cache.get<FragmentationMetrics>(cacheKey);
    if (cachedMetrics) {
      return cachedMetrics;
    }

    // Cache miss - calculate fresh metrics
    return this.calculateMetrics(cacheKey);
  }

  /**
   * Force recalculation of metrics (bypasses cache)
   * 
   * @returns Freshly calculated fragmentation metrics
   */
  async refreshMetrics(): Promise<FragmentationMetrics> {
    const cacheKey = 'fragmentation_metrics';
    return this.calculateMetrics(cacheKey);
  }

  /**
   * Calculate fragmentation metrics and cache the result
   * 
   * @param cacheKey - Cache key to store the result
   * @returns Calculated fragmentation metrics
   */
  private async calculateMetrics(cacheKey: string): Promise<FragmentationMetrics> {
    try {
      // Step 1: Aggregate pool depth data
      const aggregatedData = await this.metricAggregator.aggregatePoolDepth();

      if (aggregatedData.protocols.length === 0) {
        throw new FragmentationError(
          'Cannot calculate fragmentation metrics: no protocol data available',
          'NO_PROTOCOL_DATA'
        );
      }

      // Step 2: Calculate fragmentation metrics
      const hhiResult = this.fragmentationCalculator.calculateHHI(aggregatedData.protocols);
      const multiProtocolRoutingPct = this.fragmentationCalculator.estimateMultiProtocolRouting(
        aggregatedData.protocols
      );

      // Step 3: Calculate execution quality
      const executionQuality = await this.executionQualityScorer.computeExecutionQuality(
        hhiResult.fragmentationScore,
        aggregatedData.protocols
      );

      // Step 4: Categorize fragmentation level
      const categoryLabel = this.thresholdLabeler.categorize(hhiResult.fragmentationScore);

      // Step 5: Calculate next update time
      const timestamp = new Date().toISOString();
      const nextUpdateAt = new Date(
        Date.now() + this.config.cacheTtlSeconds * 1000
      ).toISOString();

      // Step 6: Assemble complete metrics
      const metrics: FragmentationMetrics = {
        fragmentationScore: hhiResult.fragmentationScore,
        hhi: hhiResult.hhi,
        effectiveProtocolCount: hhiResult.effectiveProtocolCount,
        multiProtocolRoutingPct,
        executionQualityScore: executionQuality.score,
        materialImpact: executionQuality.materialImpact,
        category: categoryLabel.category,
        categoryDescription: categoryLabel.description,
        protocolBreakdown: executionQuality.protocolContributions,
        dataCompleteness: aggregatedData.dataCompleteness,
        timestamp,
        nextUpdateAt,
      };

      // Cache the result
      this.cache.set(cacheKey, metrics);

      return metrics;
    } catch (error) {
      // If calculation fails, try to return stale cached data
      const staleMetrics = this.cache.get<FragmentationMetrics>(cacheKey);
      if (staleMetrics) {
        // Mark as stale and return
        return {
          ...staleMetrics,
          dataCompleteness: {
            ...staleMetrics.dataCompleteness,
            isStale: true,
            staleSince: staleMetrics.timestamp,
          },
        };
      }

      // No cached data available - rethrow error
      throw error;
    }
  }

  /**
   * Get routing recommendation based on current fragmentation
   * 
   * @param fragmentationScore - Current fragmentation score (0-100)
   * @param executionQuality - Current execution quality score (0-100)
   * @returns Routing recommendation with strategy and suggestions
   */
  getRoutingRecommendation(
    fragmentationScore: number,
    executionQuality: number
  ): RoutingRecommendation {
    // Validate inputs
    if (fragmentationScore < 0 || fragmentationScore > 100) {
      throw new FragmentationError(
        `Invalid fragmentation score: ${fragmentationScore}. Must be between 0 and 100`,
        'INVALID_FRAGMENTATION_SCORE',
        { fragmentationScore }
      );
    }

    if (executionQuality < 0 || executionQuality > 100) {
      throw new FragmentationError(
        `Invalid execution quality: ${executionQuality}. Must be between 0 and 100`,
        'INVALID_EXECUTION_QUALITY',
        { executionQuality }
      );
    }

    // Get cached metrics to access protocol breakdown
    const cachedMetrics = this.cache.get<FragmentationMetrics>('fragmentation_metrics');
    
    // Find deepest protocol
    let deepestProtocol = 'Unknown';
    if (cachedMetrics && cachedMetrics.protocolBreakdown.length > 0) {
      const deepest = cachedMetrics.protocolBreakdown.find((p) => p.isDeepest);
      if (deepest) {
        deepestProtocol = deepest.protocol;
      }
    }

    // Determine routing strategy based on fragmentation level
    let strategy: 'single-protocol' | 'multi-protocol';
    let reasoning: string;
    const alternativeSuggestions: string[] = [];

    if (fragmentationScore < this.config.lowFragmentationThreshold) {
      // Low fragmentation - recommend single-protocol routing
      strategy = 'single-protocol';
      reasoning = `Liquidity is concentrated in ${deepestProtocol}. Single-protocol routing through the dominant protocol is optimal for most trades.`;
    } else if (fragmentationScore > this.config.highFragmentationThreshold) {
      // High fragmentation - recommend multi-protocol routing
      strategy = 'multi-protocol';
      reasoning = 'Liquidity is highly fragmented across multiple protocols. Multi-protocol routing strategies are recommended to achieve optimal execution.';
    } else {
      // Medium fragmentation - conditional recommendation
      strategy = 'multi-protocol';
      reasoning = 'Liquidity is moderately distributed. Consider multi-protocol routing for larger trades to improve execution quality.';
    }

    // Add alternative suggestions when execution quality is degraded
    if (executionQuality < this.config.materialImpactThreshold) {
      alternativeSuggestions.push(
        'Consider splitting large orders into smaller chunks to reduce market impact'
      );
      alternativeSuggestions.push(
        'Monitor liquidity conditions and execute during periods of higher liquidity'
      );
      alternativeSuggestions.push(
        'Use limit orders instead of market orders to control execution price'
      );
      
      if (strategy === 'single-protocol') {
        alternativeSuggestions.push(
          'Despite low fragmentation, consider multi-protocol routing to improve execution quality'
        );
      }
    }

    return {
      strategy,
      deepestProtocol,
      alternativeSuggestions,
      reasoning,
    };
  }

  /**
   * Start polling for metrics updates
   */
  startPolling(): void {
    this.metricAggregator.startPolling(this.config.pollingIntervalMs);
  }

  /**
   * Stop polling for metrics updates
   */
  stopPolling(): void {
    this.metricAggregator.stopPolling();
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.flushAll();
  }
}
