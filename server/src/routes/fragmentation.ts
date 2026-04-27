/**
 * Fragmentation API Router
 * GET /api/liquidity/fragmentation - Returns current liquidity fragmentation metrics
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.5
 */

import { Router, type Request, type Response } from 'express';

// Import types from backend/keepers (will be shared)
interface FragmentationMetrics {
  fragmentationScore: number;
  hhi: number;
  effectiveProtocolCount: number;
  multiProtocolRoutingPct: number;
  executionQualityScore: number;
  materialImpact: boolean;
  category: 'Low' | 'Medium' | 'High';
  categoryDescription: string;
  protocolBreakdown: ProtocolContribution[];
  dataCompleteness: DataCompletenessStatus;
  timestamp: string;
  nextUpdateAt: string;
}

interface ProtocolContribution {
  protocol: string;
  tvlShare: number;
  executionImpact: number;
  isDeepest: boolean;
}

interface DataCompletenessStatus {
  poolDepthAvailable: boolean;
  routeDataAvailable: boolean;
  missingProtocols: string[];
  isStale: boolean;
  staleSince?: string;
}

interface FragmentationAPIResponse {
  success: boolean;
  data: FragmentationMetrics;
  meta: {
    cacheStatus: 'HIT' | 'MISS' | 'STALE';
    computeTimeMs: number;
    nextUpdateAt: string;
  };
  warnings?: string[];
}

interface FragmentationErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: {
      missingProtocols?: string[];
      lastSuccessfulUpdate?: string;
    };
  };
}

/**
 * Custom error types for fragmentation service
 */
class DataUnavailableError extends Error {
  constructor(message: string, public lastSuccessfulUpdate?: string) {
    super(message);
    this.name = 'DataUnavailableError';
  }
}

class PartialDataError extends Error {
  constructor(message: string, public missingProtocols: string[]) {
    super(message);
    this.name = 'PartialDataError';
  }
}

class CalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculationError';
  }
}

class InvalidRequestError extends Error {
  constructor(message: string, public details?: Record<string, string>) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/**
 * Mock FragmentationService for now
 * In production, this will be imported from backend/keepers
 */
class MockFragmentationService {
  private cachedMetrics: FragmentationMetrics | null = null;
  private lastCalculation: number = 0;
  private lastSuccessfulUpdate: string | null = null;
  private readonly CACHE_TTL_MS = 300000; // 5 minutes
  private readonly STALE_CACHE_TTL_MS = 1800000; // 30 minutes

  // Test mode flags (for simulating error scenarios)
  private testMode: {
    simulateNoData?: boolean;
    simulatePartialData?: boolean;
    simulateCalculationError?: boolean;
    simulateStaleData?: boolean;
  } = {};

  setTestMode(mode: typeof this.testMode) {
    this.testMode = mode;
  }

  async getFragmentationMetrics(): Promise<FragmentationMetrics> {
    const now = Date.now();
    
    // Simulate complete data absence
    if (this.testMode.simulateNoData) {
      throw new DataUnavailableError(
        'No pool depth data available from any protocol',
        this.lastSuccessfulUpdate || undefined
      );
    }

    // Simulate calculation error
    if (this.testMode.simulateCalculationError) {
      throw new CalculationError('Invalid calculation result: HHI produced NaN');
    }

    // Check if cache is fresh
    if (this.cachedMetrics && (now - this.lastCalculation) < this.CACHE_TTL_MS) {
      // Simulate stale data scenario
      if (this.testMode.simulateStaleData) {
        return {
          ...this.cachedMetrics,
          dataCompleteness: {
            ...this.cachedMetrics.dataCompleteness,
            isStale: true,
            staleSince: new Date(now - 360000).toISOString(), // 6 minutes ago
          },
        };
      }
      return this.cachedMetrics;
    }

    // Simulate partial data scenario
    if (this.testMode.simulatePartialData) {
      throw new PartialDataError(
        'Pool depth data unavailable for some protocols',
        ['Aquarius']
      );
    }

    // Calculate fresh metrics (mock implementation)
    const timestamp = new Date().toISOString();
    const nextUpdateAt = new Date(now + this.CACHE_TTL_MS).toISOString();

    this.cachedMetrics = {
      fragmentationScore: 45.2,
      hhi: 5480,
      effectiveProtocolCount: 1.82,
      multiProtocolRoutingPct: 35.7,
      executionQualityScore: 72.3,
      materialImpact: false,
      category: 'Medium',
      categoryDescription: 'Liquidity is moderately distributed across protocols. Consider multi-protocol routing for larger trades.',
      protocolBreakdown: [
        {
          protocol: 'Blend',
          tvlShare: 62.5,
          executionImpact: 15.2,
          isDeepest: true,
        },
        {
          protocol: 'Soroswap',
          tvlShare: 24.3,
          executionImpact: 8.7,
          isDeepest: false,
        },
        {
          protocol: 'DeFindex',
          tvlShare: 13.2,
          executionImpact: 4.1,
          isDeepest: false,
        },
      ],
      dataCompleteness: {
        poolDepthAvailable: true,
        routeDataAvailable: true,
        missingProtocols: [],
        isStale: false,
      },
      timestamp,
      nextUpdateAt,
    };

    this.lastCalculation = now;
    this.lastSuccessfulUpdate = timestamp;
    return this.cachedMetrics;
  }

  /**
   * Get metrics with partial data (used when some protocols are unavailable)
   */
  async getPartialMetrics(missingProtocols: string[]): Promise<FragmentationMetrics> {
    const now = Date.now();
    const timestamp = new Date().toISOString();
    const nextUpdateAt = new Date(now + this.CACHE_TTL_MS).toISOString();

    // Calculate metrics with available protocols only
    const availableProtocols = [
      { protocol: 'Blend', tvlShare: 72.5, executionImpact: 18.2, isDeepest: true },
      { protocol: 'Soroswap', tvlShare: 27.5, executionImpact: 9.5, isDeepest: false },
    ];

    return {
      fragmentationScore: 39.8,
      hhi: 6020,
      effectiveProtocolCount: 1.66,
      multiProtocolRoutingPct: 28.3,
      executionQualityScore: 68.5,
      materialImpact: true,
      category: 'Medium',
      categoryDescription: 'Liquidity is moderately distributed across protocols. Consider multi-protocol routing for larger trades.',
      protocolBreakdown: availableProtocols,
      dataCompleteness: {
        poolDepthAvailable: true,
        routeDataAvailable: true,
        missingProtocols,
        isStale: false,
      },
      timestamp,
      nextUpdateAt,
    };
  }

  /**
   * Get stale cached metrics (used when data sources are unavailable)
   */
  getStaleMetrics(): FragmentationMetrics | null {
    const now = Date.now();
    
    // Check if we have stale cache available (within 30 minutes)
    if (this.cachedMetrics && (now - this.lastCalculation) < this.STALE_CACHE_TTL_MS) {
      return {
        ...this.cachedMetrics,
        dataCompleteness: {
          ...this.cachedMetrics.dataCompleteness,
          isStale: true,
          staleSince: new Date(this.lastCalculation + this.CACHE_TTL_MS).toISOString(),
        },
      };
    }
    
    return null;
  }

  isCacheHit(): boolean {
    const now = Date.now();
    return this.cachedMetrics !== null && (now - this.lastCalculation) < this.CACHE_TTL_MS;
  }
}

// Singleton instance
const fragmentationService = new MockFragmentationService();

/**
 * Expose service for testing
 * @internal
 */
export function getFragmentationServiceForTesting(): MockFragmentationService {
  return fragmentationService;
}

/**
 * Reset service state for testing
 * @internal
 */
export function resetFragmentationServiceForTesting(): void {
  fragmentationService.setTestMode({});
  // Clear cache by setting it to null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fragmentationService as any).cachedMetrics = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fragmentationService as any).lastCalculation = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fragmentationService as any).lastSuccessfulUpdate = null;
}

/**
 * Create fragmentation router
 */
export function createFragmentationRouter(): Router {
  const router = Router();

  /**
   * GET /api/liquidity/fragmentation
   * Returns current fragmentation metrics with cache headers
   * 
   * Error Handling (Requirement 3.4, 7.1, 7.2, 7.3, 7.5):
   * - Data source unavailability: HTTP 200 with degraded status (stale cache)
   * - Partial protocol data: HTTP 200 with warnings
   * - Complete data absence: HTTP 503
   * - Calculation errors: HTTP 500
   * - Invalid requests: HTTP 400
   */
  router.get('/fragmentation', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      // Validate query parameters (if any are added in the future)
      // Currently no query params, but this is where validation would go
      
      // Get metrics from service
      const metrics = await fragmentationService.getFragmentationMetrics();
      const computeTimeMs = Date.now() - startTime;
      const cacheStatus = fragmentationService.isCacheHit() ? 'HIT' : 'MISS';

      // Set cache headers (Requirement 3.5)
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
      res.setHeader('X-Data-Freshness', metrics.timestamp);
      res.setHeader('X-Next-Update', metrics.nextUpdateAt);

      // Check if data is stale and add warning
      const warnings: string[] = [];
      if (metrics.dataCompleteness.isStale) {
        warnings.push('Metrics calculated using stale cached data due to data source unavailability');
      }

      // Format response
      const response: FragmentationAPIResponse = {
        success: true,
        data: metrics,
        meta: {
          cacheStatus,
          computeTimeMs,
          nextUpdateAt: metrics.nextUpdateAt,
        },
        ...(warnings.length > 0 && { warnings }),
      };

      res.status(200).json(response);

      // Log successful response
      if (process.env.NODE_ENV !== 'test') {
        console.log(
          `[Fragmentation] Metrics served - Score: ${metrics.fragmentationScore}, Cache: ${cacheStatus}, Time: ${computeTimeMs}ms, Stale: ${metrics.dataCompleteness.isStale}`
        );
      }
    } catch (error) {
      const computeTimeMs = Date.now() - startTime;

      // Log error (Requirement 7.4)
      if (process.env.NODE_ENV !== 'test') {
        console.error(`[Fragmentation] Error: ${error instanceof Error ? error.message : error}, Time: ${computeTimeMs}ms`);
      }

      // Handle different error types with appropriate responses
      
      // 1. Invalid Request Error (HTTP 400)
      if (error instanceof InvalidRequestError) {
        const errorResponse: FragmentationErrorResponse = {
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: error.message,
            details: error.details,
          },
        };
        res.status(400).json(errorResponse);
        return;
      }

      // 2. Partial Data Error (HTTP 200 with warnings)
      // Handle gracefully by calculating with available data
      if (error instanceof PartialDataError) {
        try {
          const partialMetrics = await fragmentationService.getPartialMetrics(error.missingProtocols);
          const cacheStatus = fragmentationService.isCacheHit() ? 'HIT' : 'MISS';

          // Set cache headers
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.setHeader('X-Data-Freshness', partialMetrics.timestamp);
          res.setHeader('X-Next-Update', partialMetrics.nextUpdateAt);

          const response: FragmentationAPIResponse = {
            success: true,
            data: partialMetrics,
            meta: {
              cacheStatus,
              computeTimeMs: Date.now() - startTime,
              nextUpdateAt: partialMetrics.nextUpdateAt,
            },
            warnings: [
              `Metrics calculated without data from: ${error.missingProtocols.join(', ')}`,
            ],
          };

          res.status(200).json(response);
          
          if (process.env.NODE_ENV !== 'test') {
            console.warn(
              `[Fragmentation] Partial metrics served - Missing: ${error.missingProtocols.join(', ')}`
            );
          }
          return;
        } catch (fallbackError) {
          // If we can't calculate partial metrics, fall through to data unavailable error
          if (process.env.NODE_ENV !== 'test') {
            console.error(`[Fragmentation] Failed to calculate partial metrics: ${fallbackError}`);
          }
        }
      }

      // 3. Data Unavailable Error (try stale cache first, then HTTP 503)
      if (error instanceof DataUnavailableError) {
        // Try to serve stale cached data (Requirement 7.1, 7.2)
        const staleMetrics = fragmentationService.getStaleMetrics();
        
        if (staleMetrics) {
          // Serve stale data with degraded status indicator (HTTP 200)
          res.setHeader('Cache-Control', 'public, max-age=60'); // Shorter cache for stale data
          res.setHeader('X-Data-Freshness', staleMetrics.timestamp);
          res.setHeader('X-Next-Update', staleMetrics.nextUpdateAt);
          res.setHeader('X-Cache-Status', 'STALE');

          const response: FragmentationAPIResponse = {
            success: true,
            data: staleMetrics,
            meta: {
              cacheStatus: 'STALE',
              computeTimeMs: Date.now() - startTime,
              nextUpdateAt: staleMetrics.nextUpdateAt,
            },
            warnings: [
              'Data sources temporarily unavailable. Serving stale cached metrics.',
              `Data has been stale since ${staleMetrics.dataCompleteness.staleSince}`,
            ],
          };

          res.status(200).json(response);
          
          if (process.env.NODE_ENV !== 'test') {
            console.warn(
              `[Fragmentation] Stale metrics served - Stale since: ${staleMetrics.dataCompleteness.staleSince}`
            );
          }
          return;
        }

        // No stale cache available - return 503 (Requirement 7.3)
        const errorResponse: FragmentationErrorResponse = {
          success: false,
          error: {
            code: 'NO_DATA_AVAILABLE',
            message: 'Unable to calculate fragmentation metrics: no pool depth data available',
            details: {
              lastSuccessfulUpdate: error.lastSuccessfulUpdate,
            },
          },
        };
        res.status(503).json(errorResponse);
        return;
      }

      // 4. Calculation Error (HTTP 500)
      if (error instanceof CalculationError) {
        const errorResponse: FragmentationErrorResponse = {
          success: false,
          error: {
            code: 'CALCULATION_ERROR',
            message: 'An error occurred while calculating fragmentation metrics',
            details: {
              // Don't expose internal error details to client for security
            },
          },
        };
        res.status(500).json(errorResponse);
        return;
      }

      // 5. Unknown Error (HTTP 500)
      const errorResponse: FragmentationErrorResponse = {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          details: {},
        },
      };
      res.status(500).json(errorResponse);
    }
  });

  return router;
}

// Default export for compatibility
const router = createFragmentationRouter();
export default router;
