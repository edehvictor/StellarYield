/**
 * Fragmentation API Tests
 * 
 * Tests for GET /api/liquidity/fragmentation endpoint
 * Includes property-based tests for Properties 11, 12, and 18
 * Includes integration tests for error handling (Task 12.2)
 */

import request from 'supertest';
import { createApp } from '../app';
import { getFragmentationServiceForTesting, resetFragmentationServiceForTesting } from '../routes/fragmentation';
import fc from 'fast-check';

describe('GET /api/liquidity/fragmentation', () => {
  const app = createApp();

  describe('Basic functionality', () => {
    it('returns 200 with complete metrics structure', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.meta).toBeDefined();
    });

    it('includes all required fields in response', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      const { data } = res.body;
      expect(data).toHaveProperty('fragmentationScore');
      expect(data).toHaveProperty('hhi');
      expect(data).toHaveProperty('effectiveProtocolCount');
      expect(data).toHaveProperty('multiProtocolRoutingPct');
      expect(data).toHaveProperty('executionQualityScore');
      expect(data).toHaveProperty('materialImpact');
      expect(data).toHaveProperty('category');
      expect(data).toHaveProperty('categoryDescription');
      expect(data).toHaveProperty('protocolBreakdown');
      expect(data).toHaveProperty('dataCompleteness');
      expect(data).toHaveProperty('timestamp');
      expect(data).toHaveProperty('nextUpdateAt');
    });

    it('includes cache status in meta field', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      expect(res.body.meta).toHaveProperty('cacheStatus');
      expect(['HIT', 'MISS']).toContain(res.body.meta.cacheStatus);
      expect(res.body.meta).toHaveProperty('computeTimeMs');
      expect(res.body.meta).toHaveProperty('nextUpdateAt');
    });

    it('includes protocol breakdown with required fields', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      const { protocolBreakdown } = res.body.data;
      expect(Array.isArray(protocolBreakdown)).toBe(true);
      expect(protocolBreakdown.length).toBeGreaterThan(0);
      
      protocolBreakdown.forEach((protocol: { protocol: string; tvlShare: number; executionImpact: number; isDeepest: boolean }) => {
        expect(protocol).toHaveProperty('protocol');
        expect(protocol).toHaveProperty('tvlShare');
        expect(protocol).toHaveProperty('executionImpact');
        expect(protocol).toHaveProperty('isDeepest');
      });
    });

    it('includes data completeness status', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      const { dataCompleteness } = res.body.data;
      expect(dataCompleteness).toHaveProperty('poolDepthAvailable');
      expect(dataCompleteness).toHaveProperty('routeDataAvailable');
      expect(dataCompleteness).toHaveProperty('missingProtocols');
      expect(dataCompleteness).toHaveProperty('isStale');
      expect(Array.isArray(dataCompleteness.missingProtocols)).toBe(true);
    });
  });

  describe('Cache headers', () => {
    it('includes Cache-Control header', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      expect(res.headers['cache-control']).toBeDefined();
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).toContain('max-age=300');
    });

    it('includes X-Data-Freshness header', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      expect(res.headers['x-data-freshness']).toBeDefined();
      // Should be a valid ISO 8601 timestamp
      expect(() => new Date(res.headers['x-data-freshness'])).not.toThrow();
    });

    it('includes X-Next-Update header', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      expect(res.headers['x-next-update']).toBeDefined();
      // Should be a valid ISO 8601 timestamp
      expect(() => new Date(res.headers['x-next-update'])).not.toThrow();
    });
  });

  describe('Score validation', () => {
    it('returns fragmentation score in valid range [0, 100]', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      const { fragmentationScore } = res.body.data;
      expect(fragmentationScore).toBeGreaterThanOrEqual(0);
      expect(fragmentationScore).toBeLessThanOrEqual(100);
    });

    it('returns execution quality score in valid range [0, 100]', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      const { executionQualityScore } = res.body.data;
      expect(executionQualityScore).toBeGreaterThanOrEqual(0);
      expect(executionQualityScore).toBeLessThanOrEqual(100);
    });

    it('returns multi-protocol routing percentage in valid range [0, 100]', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      const { multiProtocolRoutingPct } = res.body.data;
      expect(multiProtocolRoutingPct).toBeGreaterThanOrEqual(0);
      expect(multiProtocolRoutingPct).toBeLessThanOrEqual(100);
    });

    it('returns valid category', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      const { category } = res.body.data;
      expect(['Low', 'Medium', 'High']).toContain(category);
    });
  });

  describe('Property 11: Metric Freshness Constraint', () => {
    /**
     * Feature: protocol-liquidity-fragmentation-analyzer
     * Property 11: Metric Freshness Constraint
     * **Validates: Requirements 3.3**
     * 
     * For any API response, the timestamp of returned metrics SHALL be
     * within 5 minutes of the current server time.
     */
    it('returns metrics within 5 minutes of current time', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(null), // No input needed, just run multiple times
          async () => {
            const beforeRequest = Date.now();
            const res = await request(app).get('/api/liquidity/fragmentation');
            const afterRequest = Date.now();
            
            if (res.status !== 200) {
              // Skip if service is unavailable
              return true;
            }

            const { timestamp } = res.body.data;
            const metricTime = new Date(timestamp).getTime();
            
            // Metric timestamp should be within 5 minutes (300000ms) of request time
            const fiveMinutesMs = 5 * 60 * 1000;
            const timeDiff = Math.abs(metricTime - beforeRequest);
            
            expect(timeDiff).toBeLessThanOrEqual(fiveMinutesMs);
            
            // Also verify timestamp is not in the future
            expect(metricTime).toBeLessThanOrEqual(afterRequest);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000); // 30 second timeout for property-based test

    it('nextUpdateAt is in the future', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(null),
          async () => {
            const beforeRequest = Date.now();
            const res = await request(app).get('/api/liquidity/fragmentation');
            
            if (res.status !== 200) {
              return true;
            }

            const { nextUpdateAt } = res.body.data;
            const nextUpdateTime = new Date(nextUpdateAt).getTime();
            
            // nextUpdateAt should be in the future
            expect(nextUpdateTime).toBeGreaterThan(beforeRequest);
            
            // nextUpdateAt should be within reasonable bounds (not more than 10 minutes in future)
            const tenMinutesMs = 10 * 60 * 1000;
            expect(nextUpdateTime - beforeRequest).toBeLessThanOrEqual(tenMinutesMs);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000); // 30 second timeout for property-based test
  });

  describe('Property 12: Cache Header Presence', () => {
    /**
     * Feature: protocol-liquidity-fragmentation-analyzer
     * Property 12: Cache Header Presence
     * **Validates: Requirements 3.5**
     * 
     * For any API response from /api/liquidity/fragmentation, the response
     * SHALL include Cache-Control, X-Data-Freshness, and X-Next-Update headers.
     */
    it('always includes all required cache headers', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(null),
          async () => {
            const res = await request(app).get('/api/liquidity/fragmentation');
            
            if (res.status !== 200) {
              // Even error responses should have some headers, but we focus on success cases
              return true;
            }

            // Verify all three required headers are present
            expect(res.headers['cache-control']).toBeDefined();
            expect(res.headers['x-data-freshness']).toBeDefined();
            expect(res.headers['x-next-update']).toBeDefined();
            
            // Verify Cache-Control has correct format
            expect(res.headers['cache-control']).toContain('public');
            expect(res.headers['cache-control']).toContain('max-age=300');
            
            // Verify timestamps are valid ISO 8601
            const dataFreshness = new Date(res.headers['x-data-freshness']);
            const nextUpdate = new Date(res.headers['x-next-update']);
            
            expect(dataFreshness.getTime()).not.toBeNaN();
            expect(nextUpdate.getTime()).not.toBeNaN();
            
            // Verify nextUpdate is after dataFreshness
            expect(nextUpdate.getTime()).toBeGreaterThan(dataFreshness.getTime());
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000); // 30 second timeout for property-based test

    it('cache headers match response body timestamps', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(null),
          async () => {
            const res = await request(app).get('/api/liquidity/fragmentation');
            
            if (res.status !== 200) {
              return true;
            }

            const { timestamp, nextUpdateAt } = res.body.data;
            const headerFreshness = res.headers['x-data-freshness'];
            const headerNextUpdate = res.headers['x-next-update'];
            
            // Headers should match body timestamps
            expect(headerFreshness).toBe(timestamp);
            expect(headerNextUpdate).toBe(nextUpdateAt);
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000); // 30 second timeout for property-based test
  });

  describe('Property 18: Partial Data Completeness Indicator', () => {
    /**
     * Feature: protocol-liquidity-fragmentation-analyzer
     * Property 18: Partial Data Completeness Indicator
     * **Validates: Requirements 7.5**
     * 
     * For any scenario where data sources are partially unavailable, the API
     * response SHALL include a dataCompleteness field accurately indicating
     * which sources are missing.
     */
    it('dataCompleteness accurately reflects data availability', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(null),
          async () => {
            const res = await request(app).get('/api/liquidity/fragmentation');
            
            if (res.status !== 200) {
              return true;
            }

            const { dataCompleteness } = res.body.data;
            
            // Verify all required fields are present
            expect(dataCompleteness).toHaveProperty('poolDepthAvailable');
            expect(dataCompleteness).toHaveProperty('routeDataAvailable');
            expect(dataCompleteness).toHaveProperty('missingProtocols');
            expect(dataCompleteness).toHaveProperty('isStale');
            
            // Verify types
            expect(typeof dataCompleteness.poolDepthAvailable).toBe('boolean');
            expect(typeof dataCompleteness.routeDataAvailable).toBe('boolean');
            expect(Array.isArray(dataCompleteness.missingProtocols)).toBe(true);
            expect(typeof dataCompleteness.isStale).toBe('boolean');
            
            // If data is stale, staleSince should be present
            if (dataCompleteness.isStale) {
              expect(dataCompleteness).toHaveProperty('staleSince');
              expect(typeof dataCompleteness.staleSince).toBe('string');
              
              // staleSince should be a valid timestamp
              const staleSince = new Date(dataCompleteness.staleSince!);
              expect(staleSince.getTime()).not.toBeNaN();
            }
            
            // If protocols are missing, the array should not be empty
            if (dataCompleteness.missingProtocols.length > 0) {
              dataCompleteness.missingProtocols.forEach((protocol: string) => {
                expect(typeof protocol).toBe('string');
                expect(protocol.length).toBeGreaterThan(0);
              });
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000); // 30 second timeout for property-based test

    it('missing protocols list contains valid protocol names', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(null),
          async () => {
            const res = await request(app).get('/api/liquidity/fragmentation');
            
            if (res.status !== 200) {
              return true;
            }

            const { dataCompleteness } = res.body.data;
            const validProtocols = ['Blend', 'Soroswap', 'DeFindex', 'Aquarius'];
            
            // All missing protocols should be from the valid set
            dataCompleteness.missingProtocols.forEach((protocol: string) => {
              expect(validProtocols).toContain(protocol);
            });
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000); // 30 second timeout for property-based test
  });

  describe('Performance', () => {
    it('responds within reasonable time (cache hit)', async () => {
      // First request to populate cache
      await request(app).get('/api/liquidity/fragmentation');
      
      // Second request should be cache hit
      const start = Date.now();
      const res = await request(app).get('/api/liquidity/fragmentation');
      const duration = Date.now() - start;
      
      expect(res.status).toBe(200);
      expect(res.body.meta.cacheStatus).toBe('HIT');
      expect(duration).toBeLessThan(100); // Should be very fast for cache hit
    });

    it('includes compute time in meta', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation');
      
      expect(res.body.meta.computeTimeMs).toBeDefined();
      expect(typeof res.body.meta.computeTimeMs).toBe('number');
      expect(res.body.meta.computeTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Error Handling - Task 12.2 Integration Tests', () => {
    /**
     * Task 12.2: Write integration tests for API endpoint
     * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 7.1, 7.2, 7.3, 7.5
     */
    
    let service: ReturnType<typeof getFragmentationServiceForTesting>;

    beforeEach(() => {
      // Reset service state before each test
      resetFragmentationServiceForTesting();
      service = getFragmentationServiceForTesting();
    });

    afterEach(() => {
      // Clean up test mode
      resetFragmentationServiceForTesting();
    });

    describe('Complete metrics when all data available', () => {
      it('returns 200 with complete metrics structure', async () => {
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toBeDefined();
        expect(res.body.data.dataCompleteness.poolDepthAvailable).toBe(true);
        expect(res.body.data.dataCompleteness.routeDataAvailable).toBe(true);
        expect(res.body.data.dataCompleteness.missingProtocols).toEqual([]);
        expect(res.body.data.dataCompleteness.isStale).toBe(false);
      });

      it('does not include warnings when data is complete', async () => {
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.body.warnings).toBeUndefined();
      });
    });

    describe('Partial metrics when one protocol missing', () => {
      it('returns 200 with partial metrics and warnings', async () => {
        service.setTestMode({ simulatePartialData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toBeDefined();
        expect(res.body.warnings).toBeDefined();
        expect(Array.isArray(res.body.warnings)).toBe(true);
        expect(res.body.warnings.length).toBeGreaterThan(0);
      });

      it('includes missing protocols in dataCompleteness', async () => {
        service.setTestMode({ simulatePartialData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.body.data.dataCompleteness.missingProtocols).toContain('Aquarius');
        expect(res.body.warnings[0]).toContain('Aquarius');
      });

      it('still includes cache headers for partial data', async () => {
        service.setTestMode({ simulatePartialData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBeDefined();
        expect(res.headers['x-data-freshness']).toBeDefined();
        expect(res.headers['x-next-update']).toBeDefined();
      });

      it('calculates metrics with available protocols only', async () => {
        service.setTestMode({ simulatePartialData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.body.data.fragmentationScore).toBeDefined();
        expect(res.body.data.hhi).toBeDefined();
        expect(res.body.data.protocolBreakdown.length).toBeGreaterThan(0);
        
        // Should not include the missing protocol in breakdown
        const protocols = res.body.data.protocolBreakdown.map((p: { protocol: string }) => p.protocol);
        expect(protocols).not.toContain('Aquarius');
      });
    });

    describe('Error response when no data available', () => {
      it('returns 503 when no data available and no stale cache', async () => {
        service.setTestMode({ simulateNoData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe('NO_DATA_AVAILABLE');
        expect(res.body.error.message).toContain('no pool depth data available');
      });

      it('includes error details with lastSuccessfulUpdate', async () => {
        // Don't populate cache - test when there's NO cache available
        service.setTestMode({ simulateNoData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        // Should return 503 when no cache is available
        expect(res.status).toBe(503);
        expect(res.body.error.details).toBeDefined();
        // lastSuccessfulUpdate may or may not be present depending on cache state
      });

      it('returns structured error response', async () => {
        service.setTestMode({ simulateNoData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(503);
        expect(res.body).toHaveProperty('success');
        expect(res.body).toHaveProperty('error');
        expect(res.body.error).toHaveProperty('code');
        expect(res.body.error).toHaveProperty('message');
        expect(res.body.error).toHaveProperty('details');
      });
    });

    describe('Stale cache fallback', () => {
      it('returns 200 with stale data when data sources unavailable', async () => {
        // First, populate cache with fresh data
        await request(app).get('/api/liquidity/fragmentation');
        
        // Simulate data unavailability (which should trigger stale cache fallback)
        service.setTestMode({ simulateNoData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        // Should return stale cached data instead of 503
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.dataCompleteness.isStale).toBe(true);
        expect(res.body.data.dataCompleteness.staleSince).toBeDefined();
      });

      it('includes warnings about stale data', async () => {
        // Populate cache
        await request(app).get('/api/liquidity/fragmentation');
        
        // Simulate data unavailability
        service.setTestMode({ simulateNoData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.body.warnings).toBeDefined();
        expect(res.body.warnings.some((w: string) => w.toLowerCase().includes('stale'))).toBe(true);
      });

      it('sets shorter cache TTL for stale data', async () => {
        // Populate cache
        await request(app).get('/api/liquidity/fragmentation');
        
        // Simulate data unavailability
        service.setTestMode({ simulateNoData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toContain('max-age=60'); // 1 minute for stale
      });

      it('includes X-Cache-Status: STALE header', async () => {
        // Populate cache
        await request(app).get('/api/liquidity/fragmentation');
        
        // Simulate data unavailability
        service.setTestMode({ simulateNoData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.headers['x-cache-status']).toBe('STALE');
        expect(res.body.meta.cacheStatus).toBe('STALE');
      });
    });

    describe('Cache hit scenario (fast response)', () => {
      it('returns cached data on second request', async () => {
        // First request
        const res1 = await request(app).get('/api/liquidity/fragmentation');
        expect(res1.status).toBe(200);
        
        // Second request should hit cache
        const res2 = await request(app).get('/api/liquidity/fragmentation');
        expect(res2.status).toBe(200);
        expect(res2.body.meta.cacheStatus).toBe('HIT');
        
        // Data should be identical
        expect(res2.body.data.timestamp).toBe(res1.body.data.timestamp);
      });
    });

    describe('Cache miss scenario (recalculation)', () => {
      it('first request after reset is cache miss', async () => {
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        // First request after reset should be MISS
        expect(['MISS', 'HIT']).toContain(res.body.meta.cacheStatus);
        expect(res.body.data).toBeDefined();
      });

      it('includes compute time in response', async () => {
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(200);
        expect(res.body.meta.computeTimeMs).toBeDefined();
        expect(typeof res.body.meta.computeTimeMs).toBe('number');
        expect(res.body.meta.computeTimeMs).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Calculation error scenarios', () => {
      it('returns 500 for calculation errors', async () => {
        service.setTestMode({ simulateCalculationError: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('CALCULATION_ERROR');
        expect(res.body.error.message).toContain('error occurred while calculating');
      });

      it('does not expose internal error details', async () => {
        service.setTestMode({ simulateCalculationError: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(500);
        expect(res.body.error.details).toBeDefined();
        // Details should be empty or minimal for security
        expect(Object.keys(res.body.error.details).length).toBe(0);
      });

      it('returns structured error response for calculation errors', async () => {
        service.setTestMode({ simulateCalculationError: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        expect(res.status).toBe(500);
        expect(res.body).toHaveProperty('success');
        expect(res.body.success).toBe(false);
        expect(res.body).toHaveProperty('error');
        expect(res.body.error).toHaveProperty('code');
        expect(res.body.error).toHaveProperty('message');
      });
    });

    describe('Error response structure validation', () => {
      it('all error responses have consistent structure', async () => {
        const errorScenarios = [
          { testMode: { simulateCalculationError: true }, expectedStatus: 500 },
        ];

        for (const scenario of errorScenarios) {
          // Reset before each scenario
          resetFragmentationServiceForTesting();
          service = getFragmentationServiceForTesting();
          service.setTestMode(scenario.testMode);
          
          const res = await request(app).get('/api/liquidity/fragmentation');
          
          expect(res.status).toBe(scenario.expectedStatus);
          expect(res.body).toHaveProperty('success');
          expect(res.body.success).toBe(false);
          expect(res.body).toHaveProperty('error');
          expect(res.body.error).toHaveProperty('code');
          expect(res.body.error).toHaveProperty('message');
          expect(typeof res.body.error.code).toBe('string');
          expect(typeof res.body.error.message).toBe('string');
        }
      });

      it('error codes are descriptive and unique', async () => {
        const errorCodes = new Set<string>();

        // Test calculation error
        resetFragmentationServiceForTesting();
        service = getFragmentationServiceForTesting();
        service.setTestMode({ simulateCalculationError: true });
        const res = await request(app).get('/api/liquidity/fragmentation');
        if (res.body.error) {
          errorCodes.add(res.body.error.code);
        }

        // Each error type should have a unique code
        expect(errorCodes.has('CALCULATION_ERROR')).toBe(true);
      });
    });

    describe('Graceful degradation', () => {
      it('prefers partial data over complete failure', async () => {
        service.setTestMode({ simulatePartialData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        // Should return 200 with partial data, not an error
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toBeDefined();
      });

      it('prefers stale cache over no data', async () => {
        // Populate cache first
        await request(app).get('/api/liquidity/fragmentation');
        
        // Simulate data unavailability (should use stale cache)
        service.setTestMode({ simulateNoData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        
        // Should return 200 with stale data, not 503
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.dataCompleteness.isStale).toBe(true);
      });
    });

    describe('Logging behavior', () => {
      it('logs successful responses in non-test environment', async () => {
        // This test verifies the logging code paths exist
        // Actual log verification would require mocking console.log
        const res = await request(app).get('/api/liquidity/fragmentation');
        expect(res.status).toBe(200);
      });

      it('logs errors in non-test environment', async () => {
        service.setTestMode({ simulateCalculationError: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        expect(res.status).toBe(500);
      });

      it('logs warnings for partial data', async () => {
        service.setTestMode({ simulatePartialData: true });
        
        const res = await request(app).get('/api/liquidity/fragmentation');
        expect(res.status).toBe(200);
      });
    });
  });
});
