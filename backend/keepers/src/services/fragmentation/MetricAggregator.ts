/**
 * MetricAggregator
 * 
 * Fetches and aggregates pool depth data from all protocols.
 * Handles partial data availability and normalizes data to common format.
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2
 */

import NodeCache from 'node-cache';
import {
  ProtocolLiquidityData,
  AggregatedLiquidityData,
  DataCompletenessStatus,
  FragmentationError,
} from './types';

/**
 * Interface for yield data from external service
 */
export interface NormalizedYield {
  protocol: string;
  tvl: number;
  apy: number;
  poolCount?: number;
  timestamp?: string;
}

/**
 * Interface for yield service dependency
 */
export interface IYieldService {
  getYieldData(): Promise<NormalizedYield[]>;
}

/**
 * Expected protocols in the Stellar DeFi ecosystem
 */
const EXPECTED_PROTOCOLS = ['Blend', 'Soroswap', 'DeFindex', 'Aquarius'];

export class MetricAggregator {
  private cache: NodeCache;
  private yieldService: IYieldService;
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastFetchTime: Date | null = null;

  constructor(
    yieldService: IYieldService,
    cacheTtlSeconds: number = 300 // 5 minutes default
  ) {
    this.yieldService = yieldService;
    this.cache = new NodeCache({
      stdTTL: cacheTtlSeconds,
      checkperiod: 60, // Check for expired keys every 60 seconds
    });
  }

  /**
   * Start polling for pool depth data at specified interval
   * 
   * @param intervalMs - Polling interval in milliseconds (default: 2 minutes)
   */
  startPolling(intervalMs: number = 120000): void {
    if (this.pollingInterval) {
      throw new FragmentationError(
        'Polling already started',
        'POLLING_ALREADY_STARTED'
      );
    }

    // Fetch immediately on start
    this.aggregatePoolDepth().catch((error) => {
      console.error('Error during initial pool depth fetch:', error);
    });

    // Then poll at interval
    this.pollingInterval = setInterval(() => {
      this.aggregatePoolDepth().catch((error) => {
        console.error('Error during pool depth polling:', error);
      });
    }, intervalMs);
  }

  /**
   * Stop polling for pool depth data
   */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Fetch and aggregate pool depth data from all protocols
   * Falls back to cached data if sources are unavailable
   * 
   * @returns Aggregated liquidity data with completeness status
   */
  async aggregatePoolDepth(): Promise<AggregatedLiquidityData> {
    const cacheKey = 'aggregated_pool_depth';

    try {
      // Fetch fresh data from yield service
      const rawYields = await this.yieldService.getYieldData();
      
      // Normalize protocol data
      const protocols = this.normalizeProtocolData(rawYields);
      
      // Calculate total TVL
      const totalTvlUsd = protocols.reduce((sum, p) => sum + p.tvlUsd, 0);
      
      // Check data completeness
      const dataCompleteness = this.checkDataCompleteness(protocols);
      
      const aggregatedData: AggregatedLiquidityData = {
        protocols,
        totalTvlUsd,
        timestamp: new Date().toISOString(),
        dataCompleteness,
      };

      // Cache the fresh data
      this.cache.set(cacheKey, aggregatedData);
      this.lastFetchTime = new Date();

      return aggregatedData;
    } catch (error) {
      // Try to return cached data if available
      const cachedData = this.cache.get<AggregatedLiquidityData>(cacheKey);
      
      if (cachedData) {
        // Mark cached data as stale
        return {
          ...cachedData,
          dataCompleteness: {
            ...cachedData.dataCompleteness,
            isStale: true,
            staleSince: this.lastFetchTime?.toISOString(),
          },
        };
      }

      // No cached data available - throw error
      throw new FragmentationError(
        'Unable to fetch pool depth data and no cached data available',
        'NO_DATA_AVAILABLE',
        { originalError: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Normalize protocol data to common format
   * 
   * @param rawYields - Raw yield data from external service
   * @returns Normalized protocol liquidity data
   */
  private normalizeProtocolData(rawYields: NormalizedYield[]): ProtocolLiquidityData[] {
    return rawYields.map((yield_) => {
      // Estimate average pool depth from TVL and pool count
      const poolCount = yield_.poolCount || 1;
      const avgDepthUsd = yield_.tvl / poolCount;

      return {
        protocol: yield_.protocol,
        tvlUsd: yield_.tvl,
        poolCount,
        avgDepthUsd,
        fetchedAt: yield_.timestamp || new Date().toISOString(),
      };
    });
  }

  /**
   * Check data completeness status
   * 
   * @param protocols - Available protocol data
   * @returns Data completeness status
   */
  private checkDataCompleteness(protocols: ProtocolLiquidityData[]): DataCompletenessStatus {
    const availableProtocols = new Set(protocols.map((p) => p.protocol));
    const missingProtocols = EXPECTED_PROTOCOLS.filter(
      (protocol) => !availableProtocols.has(protocol)
    );

    return {
      poolDepthAvailable: protocols.length > 0,
      routeDataAvailable: false, // Route data not yet implemented
      missingProtocols,
      isStale: false,
    };
  }

  /**
   * Handle partial data availability
   * 
   * @param availableData - Available protocol data
   * @param expectedProtocols - List of expected protocols
   * @returns Aggregated data with completeness indicators
   */
  handlePartialData(
    availableData: ProtocolLiquidityData[],
    expectedProtocols: string[]
  ): AggregatedLiquidityData {
    const availableProtocolNames = new Set(availableData.map((p) => p.protocol));
    const missingProtocols = expectedProtocols.filter(
      (protocol) => !availableProtocolNames.has(protocol)
    );

    const totalTvlUsd = availableData.reduce((sum, p) => sum + p.tvlUsd, 0);

    return {
      protocols: availableData,
      totalTvlUsd,
      timestamp: new Date().toISOString(),
      dataCompleteness: {
        poolDepthAvailable: availableData.length > 0,
        routeDataAvailable: false,
        missingProtocols,
        isStale: false,
      },
    };
  }

  /**
   * Get cached data if available
   * 
   * @returns Cached aggregated data or null
   */
  getCachedData(): AggregatedLiquidityData | null {
    return this.cache.get<AggregatedLiquidityData>('aggregated_pool_depth') || null;
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.flushAll();
  }
}
