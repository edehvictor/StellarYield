# Implementation Plan: Protocol Liquidity Fragmentation Analyzer

## Overview

This implementation plan breaks down the Protocol Liquidity Fragmentation Analyzer feature into actionable coding tasks following a 5-phase approach: Core Calculation Engine → Data Aggregation → API Layer → Frontend Dashboard → Monitoring. The feature calculates liquidity fragmentation metrics using the Herfindahl-Hirschman Index (HHI) and provides execution quality insights to help traders understand when fragmentation impacts their trading outcomes.

**Key Technologies**: TypeScript, Node.js, Express, React, NodeCache, fast-check (property-based testing)

**Target Metrics**: <500ms calculation time, 90%+ test coverage, 25 correctness properties

## Tasks

### Phase 1: Core Calculation Engine

- [x] 1. Set up project structure and core types
  - Create directory structure: `backend/keepers/src/services/fragmentation/`
  - Define TypeScript interfaces in `types.ts`: `ProtocolLiquidityData`, `FragmentationMetrics`, `HHICalculationResult`, `ProtocolContribution`, `DataCompletenessStatus`, `FragmentationCategory`
  - Set up test directory: `backend/keepers/src/__tests__/fragmentation/`
  - Install fast-check dependency: `npm install --save-dev fast-check@^3.15.0`
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 5.1_

- [x] 2. Implement FragmentationCalculator class
  - [x] 2.1 Create FragmentationCalculator class with HHI calculation
    - Implement `calculateHHI()` method: compute HHI = Σ(market_share_i)² where shares are in percentage points
    - Implement `computeFragmentationScore()` method: Score = 100 * (1 - HHI/10000)
    - Implement `calculateEffectiveProtocolCount()` method: Effective count = 10000/HHI
    - Implement `estimateMultiProtocolRouting()` method: estimate percentage based on liquidity distribution
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [ ]* 2.2 Write property test for HHI mathematical correctness
    - **Property 2: HHI Mathematical Correctness**
    - **Validates: Requirements 1.2, 9.4**
    - Test that calculated HHI equals sum of squared market shares for any TVL distribution
    - Use fast-check to generate random protocol distributions (1-10 protocols, TVL 0-1B)
    - Run 100 iterations minimum

  - [ ]* 2.3 Write property test for score range validity
    - **Property 1: Score Range Validity**
    - **Validates: Requirements 1.1, 2.1**
    - Test that fragmentation score is always in [0, 100] for any valid input
    - Use fast-check to generate random protocol data
    - Run 100 iterations minimum

  - [ ]* 2.4 Write property test for effective protocol count relationship
    - **Property 3: Effective Protocol Count Relationship**
    - **Validates: Requirements 1.3**
    - Test that effective count = 10000/HHI for any valid HHI
    - Use fast-check to generate random HHI values
    - Run 100 iterations minimum

  - [ ]* 2.5 Write property test for multi-protocol routing percentage range
    - **Property 4: Multi-Protocol Routing Percentage Range**
    - **Validates: Requirements 1.4**
    - Test that routing percentage is always in [0, 100]
    - Use fast-check to generate random route distributions
    - Run 100 iterations minimum

  - [ ]* 2.6 Write unit tests for edge cases
    - Test zero liquidity scenario
    - Test single protocol dominance (100% market share)
    - Test equal distribution across protocols
    - Test boundary values (HHI = 0, HHI = 10000)
    - _Requirements: 9.3_

- [x] 3. Implement ThresholdLabeler class
  - [x] 3.1 Create ThresholdLabeler class with categorization logic
    - Implement `categorize()` method: map score to Low (<30), Medium (30-60), High (>60)
    - Implement `getDescription()` method: provide descriptive text for each category
    - Implement `getVisualIndicators()` method: return color and icon for each category
    - Handle boundary conditions: 30 → Medium, 60 → High
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 3.2 Write property test for threshold categorization completeness
    - **Property 13: Threshold Categorization Completeness**
    - **Validates: Requirements 5.1, 5.2, 5.3, 10.1, 10.2**
    - Test that every score in [0, 100] maps to exactly one category
    - Use fast-check to generate random scores
    - Run 100 iterations minimum

  - [ ]* 3.3 Write property test for threshold boundary handling
    - **Property 14: Threshold Boundary Handling**
    - **Validates: Requirements 10.3**
    - Test that boundary values (30, 60) assign to higher category
    - Test specific values: 29.99 → Low, 30 → Medium, 59.99 → Medium, 60 → High

  - [ ]* 3.4 Write property test for category description presence
    - **Property 15: Category Description Presence**
    - **Validates: Requirements 5.4**
    - Test that all categories have non-empty descriptions
    - Test all three categories: Low, Medium, High

  - [ ]* 3.5 Write property test for visual indicator mapping
    - **Property 16: Visual Indicator Mapping**
    - **Validates: Requirements 5.5**
    - Test that all categories have non-empty color and icon identifiers

  - [ ]* 3.6 Write property test for threshold labeler idempotence
    - **Property 25: Threshold Labeler Idempotence**
    - **Validates: Requirements 10.4**
    - Test that calling categorize() multiple times with same score returns same category
    - Use fast-check to generate random scores and call categorize() 10 times each
    - Run 100 iterations minimum

  - [ ]* 3.7 Write unit tests for boundary conditions
    - Test score = 0 → Low
    - Test score = 100 → High
    - Test score = 30 → Medium
    - Test score = 60 → High
    - _Requirements: 10.5_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run all property-based tests and unit tests
  - Verify 100% coverage for FragmentationCalculator and ThresholdLabeler
  - Ensure all 25 correctness properties are implemented
  - Ask the user if questions arise

### Phase 2: Data Aggregation and Caching

- [x] 5. Implement MetricAggregator class
  - [x] 5.1 Create MetricAggregator class with data fetching
    - Integrate with existing YieldService to fetch pool depth data
    - Implement `aggregatePoolDepth()` method: fetch and aggregate data from all protocols
    - Implement `normalizeProtocolData()` method: convert NormalizedYield[] to ProtocolLiquidityData[]
    - Implement `handlePartialData()` method: handle missing protocol data gracefully
    - Set up 2-minute polling interval using setInterval
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2_

  - [ ]* 5.2 Write property test for data normalization format consistency
    - **Property 17: Data Normalization Format Consistency**
    - **Validates: Requirements 6.4**
    - Test that normalized data always has required fields: protocol, tvlUsd, poolCount, avgDepthUsd, timestamp
    - Use fast-check to generate various input formats
    - Run 100 iterations minimum

  - [ ]* 5.3 Write property test for aggregation round-trip preservation
    - **Property 23: Aggregation Round-Trip Preservation**
    - **Validates: Requirements 9.1**
    - Test that aggregating then disaggregating preserves TVL distribution within 1% tolerance
    - Use fast-check to generate random protocol data
    - Run 100 iterations minimum

  - [ ]* 5.4 Write unit tests for partial data handling
    - Test scenario: one protocol missing
    - Test scenario: multiple protocols missing
    - Test scenario: all protocols missing (should throw error)
    - Verify dataCompleteness field is correctly populated
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 6. Implement ExecutionQualityScorer class
  - [x] 6.1 Create ExecutionQualityScorer class with quality calculation
    - Implement `computeExecutionQuality()` method: Score = 100 - (slippage_impact * 0.6 + routing_complexity * 0.4)
    - Implement `analyzeProtocolContributions()` method: identify which protocols contribute to quality degradation
    - Implement `hasMaterialImpact()` method: return true if score < 70
    - Integrate with existing SlippageRegistry for slippage estimates
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ]* 6.2 Write property test for slippage impact monotonicity
    - **Property 6: Slippage Impact Monotonicity**
    - **Validates: Requirements 2.2**
    - Test that higher slippage never improves execution quality
    - Use fast-check to generate pairs of scenarios with different slippage
    - Run 100 iterations minimum

  - [ ]* 6.3 Write property test for routing complexity impact monotonicity
    - **Property 7: Routing Complexity Impact Monotonicity**
    - **Validates: Requirements 2.3**
    - Test that higher routing complexity never improves execution quality
    - Use fast-check to generate pairs of scenarios with different complexity
    - Run 100 iterations minimum

  - [ ]* 6.4 Write property test for material impact threshold consistency
    - **Property 8: Material Impact Threshold Consistency**
    - **Validates: Requirements 2.4**
    - Test that material impact flag is true iff score < 70
    - Use fast-check to generate random quality scores
    - Run 100 iterations minimum

  - [ ]* 6.5 Write property test for protocol contribution sum
    - **Property 9: Protocol Contribution Sum**
    - **Validates: Requirements 2.5**
    - Test that protocol contributions sum to 100% (within 0.1% tolerance)
    - Use fast-check to generate random protocol data
    - Run 100 iterations minimum

  - [ ]* 6.6 Write unit tests for execution quality edge cases
    - Test zero slippage scenario
    - Test maximum slippage scenario
    - Test single protocol vs multi-protocol routing
    - Test material impact boundary (score = 69.99 vs 70.01)
    - _Requirements: 2.4_

- [x] 7. Implement caching layer
  - [x] 7.1 Set up NodeCache with 5-minute TTL
    - Initialize NodeCache instance in FragmentationService
    - Configure TTL: 300 seconds (5 minutes)
    - Configure stale cache: 1800 seconds (30 minutes) for fallback
    - Implement cache key generation based on data timestamp
    - _Requirements: 3.3, 6.3_

  - [ ]* 7.2 Write unit tests for cache behavior
    - Test cache hit returns cached data
    - Test cache miss triggers recalculation
    - Test stale cache fallback when data unavailable
    - Test cache invalidation after TTL expires
    - Test cache warming on service startup
    - _Requirements: 3.3_

- [ ] 8. Implement error handling and graceful degradation
  - [ ] 8.1 Implement circuit breaker pattern
    - Create CircuitBreaker class with CLOSED/OPEN/HALF_OPEN states
    - Configure failure threshold: 5 failures
    - Configure reset timeout: 60 seconds
    - Wrap data fetching calls with circuit breaker
    - _Requirements: 7.3, 7.4_

  - [ ] 8.2 Implement exponential backoff for retries
    - Create fetchWithRetry() utility function
    - Configure max retries: 3
    - Configure base delay: 1000ms
    - Apply to YieldService and SlippageRegistry calls
    - _Requirements: 6.3, 7.3_

  - [ ]* 8.3 Write unit tests for error handling
    - Test circuit breaker opens after 5 failures
    - Test circuit breaker resets after timeout
    - Test exponential backoff delays
    - Test graceful degradation with partial data
    - Test error logging for monitoring
    - _Requirements: 7.4_

- [x] 9. Checkpoint - Ensure all tests pass
  - Run all property-based tests and unit tests for Phase 2
  - Verify integration with YieldService works correctly
  - Verify cache hit rate > 80% in local testing
  - Verify graceful degradation scenarios work
  - Ask the user if questions arise

### Phase 3: API Layer

- [ ] 10. Implement FragmentationService orchestration class
  - [x] 10.1 Create FragmentationService class
    - Initialize all dependencies: MetricAggregator, FragmentationCalculator, ExecutionQualityScorer, ThresholdLabeler, NodeCache
    - Implement `getFragmentationMetrics()` method: orchestrate calculation flow with cache support
    - Implement `refreshMetrics()` method: force recalculation bypassing cache
    - Implement `getRoutingRecommendation()` method: provide routing advice based on fragmentation
    - _Requirements: 3.1, 3.2, 8.1, 8.2, 8.3, 8.4_

  - [ ]* 10.2 Write property test for timestamp presence
    - **Property 5: Timestamp Presence**
    - **Validates: Requirements 1.5**
    - Test that all metrics include valid ISO 8601 timestamp
    - Use fast-check to generate random metric calculations
    - Run 100 iterations minimum

  - [ ]* 10.3 Write property test for API response structure completeness
    - **Property 10: API Response Structure Completeness**
    - **Validates: Requirements 3.2**
    - Test that response contains all required fields: fragmentationScore, hhi, effectiveProtocolCount, executionQualityScore, category, timestamp, dataCompleteness
    - Use fast-check to generate random scenarios
    - Run 100 iterations minimum

  - [ ]* 10.4 Write property test for high fragmentation routing recommendation
    - **Property 19: High Fragmentation Routing Recommendation**
    - **Validates: Requirements 8.1**
    - Test that score > 60 recommends multi-protocol routing
    - Use fast-check to generate high fragmentation scenarios
    - Run 100 iterations minimum

  - [ ]* 10.5 Write property test for low fragmentation routing recommendation
    - **Property 20: Low Fragmentation Routing Recommendation**
    - **Validates: Requirements 8.2**
    - Test that score < 30 recommends single-protocol routing
    - Use fast-check to generate low fragmentation scenarios
    - Run 100 iterations minimum

  - [ ]* 10.6 Write property test for deepest liquidity protocol identification
    - **Property 21: Deepest Liquidity Protocol Identification**
    - **Validates: Requirements 8.3**
    - Test that protocol with max TVL is identified as deepest
    - Use fast-check to generate random protocol data
    - Run 100 iterations minimum

  - [ ]* 10.7 Write property test for degraded quality alternative suggestions
    - **Property 22: Degraded Quality Alternative Suggestions**
    - **Validates: Requirements 8.4**
    - Test that quality score < 70 provides at least one alternative suggestion
    - Use fast-check to generate degraded quality scenarios
    - Run 100 iterations minimum

- [ ] 11. Implement API endpoint
  - [x] 11.1 Create GET /api/liquidity/fragmentation endpoint
    - Add route handler in Express app
    - Call FragmentationService.getFragmentationMetrics()
    - Format response with success/data/meta structure
    - Add error handling for all error scenarios
    - _Requirements: 3.1, 3.2_

  - [x] 11.2 Add cache headers to API response
    - Set Cache-Control: public, max-age=300
    - Set X-Data-Freshness header with timestamp
    - Set X-Next-Update header with next update time
    - Include cache status in meta field (HIT/MISS)
    - _Requirements: 3.5_

  - [ ]* 11.3 Write property test for metric freshness constraint
    - **Property 11: Metric Freshness Constraint**
    - **Validates: Requirements 3.3**
    - Test that returned metrics are within 5 minutes of current time
    - Use fast-check to generate various cache scenarios
    - Run 100 iterations minimum

  - [ ]* 11.4 Write property test for cache header presence
    - **Property 12: Cache Header Presence**
    - **Validates: Requirements 3.5**
    - Test that response includes Cache-Control, X-Data-Freshness, X-Next-Update headers
    - Use fast-check to generate random API requests
    - Run 100 iterations minimum

  - [ ]* 11.5 Write property test for partial data completeness indicator
    - **Property 18: Partial Data Completeness Indicator**
    - **Validates: Requirements 7.5**
    - Test that dataCompleteness field accurately indicates missing sources
    - Use fast-check to generate partial data scenarios
    - Run 100 iterations minimum

- [x] 12. Implement API error handling
  - [x] 12.1 Add error response formatting
    - Create error response structure: success=false, error object with code/message/details
    - Handle data source unavailability (HTTP 200 with degraded status)
    - Handle partial protocol data (HTTP 200 with warnings)
    - Handle complete data absence (HTTP 503)
    - Handle calculation errors (HTTP 500)
    - Handle invalid requests (HTTP 400)
    - _Requirements: 3.4, 7.1, 7.2, 7.3, 7.5_

  - [ ]* 12.2 Write integration tests for API endpoint
    - Test complete metrics when all data available
    - Test partial metrics when one protocol missing
    - Test error response when no data available
    - Test cache hit scenario (fast response)
    - Test cache miss scenario (recalculation)
    - Test stale cache fallback
    - Test error scenarios (service down, calculation failure)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 13. Checkpoint - Ensure all tests pass
  - Run all API integration tests
  - Verify API response time < 50ms (cache hit) or < 500ms (cache miss)
  - Verify all error scenarios return correct HTTP status codes
  - Verify cache headers are correctly set
  - Ask the user if questions arise

### Phase 4: Frontend Dashboard

- [-] 14. Create FragmentationDashboard React component
  - [x] 14.1 Set up component structure and API integration
    - Create `client/src/features/fragmentation/FragmentationDashboard.tsx`
    - Create `client/src/features/fragmentation/types.ts` with TypeScript interfaces
    - Implement API fetch using existing `api.ts` utility
    - Add auto-refresh with configurable interval (default 60 seconds)
    - Implement loading and error states
    - _Requirements: 4.1, 4.2, 4.5_

  - [x] 14.2 Implement FragmentationScoreCard component
    - Display fragmentation score with visual indicator (Low/Medium/High)
    - Use color coding: Low (green), Medium (yellow), High (red)
    - Show category description text
    - Display icon based on category
    - _Requirements: 4.1, 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 14.3 Implement ExecutionQualityCard component
    - Display execution quality score with color-coded gauge
    - Use color coding: >70 (green), 50-70 (yellow), <50 (red)
    - Show material impact warning when score < 70
    - Display timestamp of last update
    - _Requirements: 4.2, 4.3, 4.5_

  - [x] 14.4 Implement EffectiveProtocolsCard component
    - Display effective protocol count
    - Show HHI value with explanation tooltip
    - Display multi-protocol routing percentage
    - _Requirements: 4.1_

  - [x] 14.5 Implement MaterialImpactWarning component
    - Show warning banner when materialImpact is true
    - Display descriptive text explaining the impact
    - Show routing recommendations
    - Include dismiss button
    - _Requirements: 4.3, 8.4_

  - [x] 14.6 Implement ProtocolDistributionChart component
    - Create bar chart or pie chart showing TVL distribution
    - Use existing chart library (recharts or similar)
    - Show protocol names and percentages
    - Highlight protocol with deepest liquidity
    - Make chart responsive for mobile and desktop
    - _Requirements: 4.4, 8.3_

  - [x] 14.7 Implement RoutingRecommendations component
    - Display routing recommendations based on fragmentation level
    - Show recommended strategy (single-protocol vs multi-protocol)
    - Display deepest liquidity protocol
    - Show alternative suggestions when quality is degraded
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 14.8 Implement DataFreshnessIndicator component
    - Display last update timestamp
    - Show next update countdown
    - Display data completeness status
    - Show warning if data is stale or partial
    - _Requirements: 4.5, 7.5_

  - [x] 14.9 Add component styling and responsive design
    - Create CSS module or styled-components
    - Ensure responsive layout for mobile and desktop
    - Add loading skeletons for better UX
    - Add smooth transitions for data updates
    - Follow existing design system

  - [ ]* 14.10 Write unit tests for React components
    - Test component renders correctly for all fragmentation levels
    - Test material impact warning appears when appropriate
    - Test chart displays protocol distribution accurately
    - Test auto-refresh works without memory leaks
    - Test error state handling
    - Test loading state handling
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [-] 15. Integrate dashboard into main application
  - [x] 15.1 Add route for fragmentation dashboard
    - Add route in React Router configuration
    - Add navigation link in main menu
    - Add feature flag for gradual rollout
    - _Requirements: 4.1_

  - [ ]* 15.2 Write integration tests for dashboard
    - Test dashboard fetches data on mount
    - Test dashboard updates data on refresh
    - Test dashboard handles API errors gracefully
    - Test dashboard respects feature flag
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 16. Checkpoint - Ensure all tests pass
  - Run all frontend unit and integration tests
  - Verify dashboard renders correctly in browser
  - Verify auto-refresh works without memory leaks
  - Verify responsive design works on mobile and desktop
  - Ask the user if questions arise

### Phase 5: Monitoring and Optimization

- [ ] 17. Add logging and monitoring instrumentation
  - [ ] 17.1 Add structured logging
    - Add ERROR logs for: complete data absence, calculation failures, unexpected exceptions
    - Add WARN logs for: partial data availability, stale cache usage, slow calculations (>500ms)
    - Add INFO logs for: successful calculations, cache hits/misses, API requests
    - Add DEBUG logs for: detailed calculation steps, data normalization, threshold evaluations
    - Use existing logging framework (Winston or similar)
    - _Requirements: 7.4_

  - [ ] 17.2 Add performance metrics tracking
    - Track calculation time (p50, p95, p99)
    - Track API response time
    - Track cache lookup time
    - Track data fetch time
    - Track cache hit rate
    - Use existing metrics framework (Prometheus or similar)

  - [ ] 17.3 Add business metrics tracking
    - Track average fragmentation score over time
    - Track material impact frequency
    - Track protocol distribution changes
    - Track routing recommendation distribution
    - Store metrics in time-series database

  - [ ] 17.4 Add error metrics tracking
    - Track error rate by type
    - Track failed calculation count
    - Track data unavailability duration
    - Track circuit breaker state changes

- [ ] 18. Implement performance optimizations
  - [ ] 18.1 Add memoization for expensive calculations
    - Memoize HHI calculation results
    - Memoize protocol share calculations
    - Memoize execution quality calculations
    - Use LRU cache for memoization

  - [ ] 18.2 Add parallel processing for independent calculations
    - Calculate fragmentation score and execution quality in parallel
    - Fetch pool depth and route data in parallel
    - Use Promise.all() for concurrent operations

  - [ ] 18.3 Add cache warming on service startup
    - Pre-calculate metrics on service startup
    - Populate cache with initial data
    - Reduce cold start latency

  - [ ]* 18.4 Write performance tests
    - Test calculation time < 500ms for typical inputs
    - Test API response time < 50ms (cache hit)
    - Test API response time < 500ms (cache miss)
    - Test system handles 100 req/s without degradation
    - _Requirements: 6.5, 9.5_

- [ ] 19. Add monitoring alerts and dashboards
  - [ ] 19.1 Configure availability alerts
    - Alert if data source unavailable for > 5 minutes
    - Alert if API error rate > 5%
    - Alert if circuit breaker opens

  - [ ] 19.2 Configure performance alerts
    - Alert if P95 response time > 500ms
    - Alert if calculation time > 500ms
    - Alert if cache hit rate < 70%

  - [ ] 19.3 Configure business alerts
    - Alert if fragmentation score changes by > 20 points in 10 minutes
    - Alert if material impact persists for > 30 minutes
    - Alert if protocol data missing for > 10 minutes

  - [ ] 19.4 Create monitoring dashboard
    - Create Grafana dashboard (or similar) with key metrics
    - Add panels for availability, performance, and business metrics
    - Add panels for error rates and circuit breaker status

- [ ] 20. Write documentation and runbooks
  - [ ] 20.1 Write API documentation
    - Document GET /api/liquidity/fragmentation endpoint
    - Document request/response schemas
    - Document error codes and meanings
    - Document cache headers and behavior
    - Add examples for all scenarios

  - [ ] 20.2 Write operational runbooks
    - Document how to deploy the service
    - Document how to monitor the service
    - Document how to troubleshoot common issues
    - Document how to roll back if needed
    - Document environment variables and configuration

  - [ ] 20.3 Write developer documentation
    - Document architecture and design decisions
    - Document how to add new protocols
    - Document how to add new fragmentation metrics
    - Document how to run tests locally
    - Document how to contribute

- [ ] 21. Final checkpoint - Ensure all tests pass
  - Run complete test suite (unit, integration, property-based, performance)
  - Verify 90%+ test coverage achieved
  - Verify all 25 correctness properties pass
  - Verify performance targets met (<500ms calculation, <50ms cache hit)
  - Verify monitoring and alerting configured
  - Verify documentation complete
  - Ask the user if questions arise

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at phase boundaries
- Property tests validate universal correctness properties (25 total)
- Unit tests validate specific examples and edge cases
- Integration tests validate end-to-end flows
- Target: 90%+ test coverage, <500ms calculation time, 5-minute cache freshness
- Use TypeScript throughout for type safety
- Use fast-check library for property-based testing (100 iterations minimum per property)
- Use existing services: YieldService, SlippageRegistry, StellarNetworkService
- Use NodeCache for caching with 5-minute TTL
- Follow existing code patterns and conventions in the codebase
