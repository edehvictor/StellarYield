# Requirements Document

## Introduction

The Protocol Liquidity Fragmentation Analyzer measures how liquidity is distributed across Stellar DeFi protocols (Blend, Soroswap, DeFindex, Aquarius) and quantifies the impact of fragmentation on trade execution quality. This feature helps users understand when liquidity fragmentation materially affects their trading outcomes and provides insights for optimal routing strategies.

## Glossary

- **Fragmentation_Analyzer**: The service that calculates liquidity fragmentation metrics across protocols
- **Pool_Depth_Service**: The service that provides liquidity depth data for individual pools
- **Route_Distribution_Service**: The service that provides data on how trades are routed across protocols
- **Fragmentation_Metric**: A quantitative measure of liquidity distribution across protocols
- **Execution_Quality_Score**: A measure of expected trade execution quality given current liquidity conditions
- **Material_Impact_Threshold**: The fragmentation level at which execution quality is significantly affected
- **Backend_API**: The Node.js API layer that exposes fragmentation metrics
- **Dashboard_View**: The React component that displays fragmentation metrics to users
- **Metric_Aggregator**: The component that combines pool depth and route data into fragmentation metrics
- **Threshold_Labeler**: The component that categorizes fragmentation levels (Low, Medium, High)

## Requirements

### Requirement 1: Calculate Liquidity Fragmentation Metrics

**User Story:** As a trader, I want to see how liquidity is distributed across protocols, so that I can understand the current market structure.

#### Acceptance Criteria

1. WHEN pool depth data is available for all protocols, THE Fragmentation_Analyzer SHALL calculate a fragmentation score between 0 and 100
2. THE Fragmentation_Analyzer SHALL compute the Herfindahl-Hirschman Index (HHI) based on protocol TVL shares
3. THE Fragmentation_Analyzer SHALL calculate the effective number of protocols (1/HHI) as a fragmentation metric
4. WHEN route distribution data is available, THE Fragmentation_Analyzer SHALL calculate the percentage of trades requiring multi-protocol routing
5. FOR ALL calculated metrics, THE Fragmentation_Analyzer SHALL include a timestamp indicating data freshness

### Requirement 2: Assess Execution Quality Impact

**User Story:** As a trader, I want to know how fragmentation affects my trade execution, so that I can make informed trading decisions.

#### Acceptance Criteria

1. WHEN fragmentation metrics are calculated, THE Fragmentation_Analyzer SHALL compute an Execution_Quality_Score between 0 and 100
2. THE Fragmentation_Analyzer SHALL factor in average slippage across protocols when computing the Execution_Quality_Score
3. THE Fragmentation_Analyzer SHALL factor in routing complexity when computing the Execution_Quality_Score
4. WHEN the Execution_Quality_Score falls below 70, THE Fragmentation_Analyzer SHALL flag the condition as material impact
5. THE Fragmentation_Analyzer SHALL provide a breakdown showing which protocols contribute most to execution quality degradation

### Requirement 3: Expose Fragmentation Metrics via Backend API

**User Story:** As a frontend developer, I want to access fragmentation metrics through an API, so that I can display them in the dashboard.

#### Acceptance Criteria

1. THE Backend_API SHALL expose a GET endpoint at /api/liquidity/fragmentation returning current fragmentation metrics
2. WHEN the fragmentation endpoint is called, THE Backend_API SHALL return fragmentation score, HHI, effective protocol count, and execution quality score
3. THE Backend_API SHALL return metrics with a maximum age of 5 minutes
4. WHEN pool depth or route data is unavailable, THE Backend_API SHALL return partial metrics with a degraded status indicator
5. THE Backend_API SHALL include cache headers indicating metric freshness and next update time

### Requirement 4: Display Fragmentation Metrics in Dashboard

**User Story:** As a user, I want to see fragmentation metrics in my dashboard, so that I can monitor market conditions at a glance.

#### Acceptance Criteria

1. THE Dashboard_View SHALL display the current fragmentation score with visual indicators (Low, Medium, High)
2. THE Dashboard_View SHALL display the execution quality score with color-coded status
3. WHEN material impact is detected, THE Dashboard_View SHALL highlight the condition with a warning indicator
4. THE Dashboard_View SHALL show the distribution of liquidity across protocols using a visual breakdown
5. THE Dashboard_View SHALL display the timestamp of the last metric update

### Requirement 5: Categorize Fragmentation Levels

**User Story:** As a user, I want fragmentation levels labeled clearly, so that I can quickly understand market conditions.

#### Acceptance Criteria

1. WHEN the fragmentation score is below 30, THE Threshold_Labeler SHALL categorize it as Low fragmentation
2. WHEN the fragmentation score is between 30 and 60, THE Threshold_Labeler SHALL categorize it as Medium fragmentation
3. WHEN the fragmentation score is above 60, THE Threshold_Labeler SHALL categorize it as High fragmentation
4. THE Threshold_Labeler SHALL provide descriptive text explaining what each fragmentation level means for trading
5. THE Threshold_Labeler SHALL map fragmentation categories to visual indicators (colors, icons)

### Requirement 6: Aggregate Pool Depth and Route Data

**User Story:** As the system, I want to combine pool depth and route data efficiently, so that fragmentation metrics are accurate and timely.

#### Acceptance Criteria

1. THE Metric_Aggregator SHALL fetch pool depth data from the Pool_Depth_Service at 2-minute intervals
2. THE Metric_Aggregator SHALL fetch route distribution data from the Route_Distribution_Service at 2-minute intervals
3. WHEN either data source is unavailable, THE Metric_Aggregator SHALL use the most recent cached data and mark metrics as stale
4. THE Metric_Aggregator SHALL normalize pool depth data across different protocols to a common format
5. THE Metric_Aggregator SHALL compute aggregate metrics within 500ms of receiving source data

### Requirement 7: Handle Partial Data Gracefully

**User Story:** As a system administrator, I want the analyzer to degrade gracefully when data is incomplete, so that users still receive useful information.

#### Acceptance Criteria

1. WHEN pool depth data is unavailable for one protocol, THE Fragmentation_Analyzer SHALL calculate metrics using available protocols and indicate partial data
2. WHEN route distribution data is unavailable, THE Fragmentation_Analyzer SHALL calculate fragmentation based solely on TVL distribution
3. IF no pool depth data is available, THEN THE Fragmentation_Analyzer SHALL return an error status with a descriptive message
4. THE Fragmentation_Analyzer SHALL log all data unavailability events for monitoring purposes
5. WHEN partial data is used, THE Backend_API SHALL include a data_completeness field indicating which sources are missing

### Requirement 8: Provide Optimal Routing Insights

**User Story:** As a trader, I want routing recommendations based on current fragmentation, so that I can optimize my trade execution.

#### Acceptance Criteria

1. WHEN fragmentation is High, THE Fragmentation_Analyzer SHALL recommend multi-protocol routing strategies
2. WHEN fragmentation is Low, THE Fragmentation_Analyzer SHALL recommend single-protocol routing
3. THE Fragmentation_Analyzer SHALL identify the protocol with the deepest liquidity for each asset pair
4. WHEN execution quality is degraded, THE Fragmentation_Analyzer SHALL suggest alternative trading times or strategies
5. THE Dashboard_View SHALL display routing recommendations alongside fragmentation metrics

### Requirement 9: Test Metric Aggregation Logic

**User Story:** As a developer, I want comprehensive tests for metric aggregation, so that I can ensure calculation accuracy.

#### Acceptance Criteria

1. FOR ALL valid pool depth and route data combinations, aggregating then disaggregating SHALL preserve the original protocol distribution within 1% tolerance
2. WHEN pool depth data varies, THE Metric_Aggregator SHALL produce fragmentation scores that increase monotonically with distribution evenness
3. THE Metric_Aggregator SHALL handle edge cases including zero liquidity, single protocol dominance, and equal distribution
4. THE Metric_Aggregator SHALL correctly compute HHI for all valid TVL distributions
5. THE Metric_Aggregator SHALL achieve 90% test coverage including error paths

### Requirement 10: Test Threshold Labeling Logic

**User Story:** As a developer, I want tests for threshold labeling, so that I can ensure correct categorization.

#### Acceptance Criteria

1. FOR ALL fragmentation scores in [0, 100], THE Threshold_Labeler SHALL assign exactly one category (Low, Medium, High)
2. THE Threshold_Labeler SHALL assign Low for scores below 30, Medium for scores 30-60, and High for scores above 60
3. WHEN the fragmentation score is exactly at a boundary (30 or 60), THE Threshold_Labeler SHALL assign the higher category
4. THE Threshold_Labeler SHALL provide consistent category assignments for the same input score
5. THE Threshold_Labeler SHALL achieve 100% test coverage for all boundary conditions
