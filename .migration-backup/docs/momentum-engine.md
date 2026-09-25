# Multi-Window Opportunity Momentum Engine

The Momentum Engine scores opportunities across short, medium, and long windows instead of relying on single-point APY snapshots. It combines momentum with confidence and liquidity factors for comprehensive opportunity ranking.

## Overview

Traditional yield aggregators rely on point-in-time APY snapshots, which can be misleading due to temporary spikes or dips. The Momentum Engine analyzes trends across multiple time windows to provide more reliable opportunity scoring.

### Key Features

- **Multi-window analysis**: Short (1 day), medium (7 days), and long (30 days) momentum calculation
- **Trend analysis**: Linear regression-based trend detection for APY, TVL, and confidence
- **Risk integration**: Momentum signals respect hard risk and trust exclusions
- **Volatility adjustment**: Penalties for high volatility, bonuses for consistency
- **Confidence weighting**: Adjustments based on data reliability and liquidity scores

## Architecture

### Core Components

1. **OpportunitySnapshot**: Historical data points for protocols
2. **MomentumMetrics**: Trend analysis for each time window
3. **OpportunityMomentumScore**: Comprehensive scoring with multiple factors
4. **MomentumEngine**: Main analysis engine with configurable parameters

### Data Flow

```
Historical Snapshots → Window Analysis → Trend Calculation → Risk Adjustment → Final Score
```

## API Endpoints

### Add Snapshots

```http
POST /api/momentum/snapshots
Content-Type: application/json

{
  "snapshots": [
    {
      "timestamp": 1640995200000,
      "protocolName": "Blend",
      "apy": 8.5,
      "tvl": 1000000,
      "confidence": 0.9,
      "liquidityScore": 0.8,
      "riskScore": 0.3
    }
  ]
}
```

### Get Analysis

```http
GET /api/momentum/analysis?timestamp=1640995200000
```

**Response:**
```json
{
  "success": true,
  "data": {
    "opportunities": [...],
    "rankedOpportunities": [...],
    "summary": {
      "totalOpportunities": 5,
      "risingCount": 2,
      "flatCount": 2,
      "decliningCount": 1,
      "averageMomentum": 0.65,
      "topMomentumProtocol": "Blend",
      "analysisTimestamp": 1640995200000
    }
  }
}
```

### Get Protocol Score

```http
GET /api/momentum/protocols/Blend?timestamp=1640995200000
```

**Response:**
```json
{
  "success": true,
  "data": {
    "protocolName": "Blend",
    "currentApy": 8.5,
    "currentTvl": 1000000,
    "currentConfidence": 0.9,
    "currentLiquidityScore": 0.8,
    "currentRiskScore": 0.3,
    "shortWindowMomentum": {
      "window": { "name": "short", "durationMs": 86400000, "weight": 0.5 },
      "apyTrend": 0.15,
      "tvlTrend": 0.08,
      "confidenceTrend": 0.05,
      "volatility": 0.12,
      "consistency": 0.88,
      "momentum": 0.72
    },
    "mediumWindowMomentum": { ... },
    "longWindowMomentum": { ... },
    "overallMomentum": 0.68,
    "confidenceAdjustedMomentum": 0.75,
    "liquidityAdjustedMomentum": 0.78,
    "finalScore": 0.74,
    "momentumClass": "rising",
    "riskAdjustment": 0.955,
    "calculatedAt": 1640995200000,
    "dataPoints": 15,
    "reliability": 0.95
  }
}
```

### Get Ranking

```http
GET /api/momentum/ranking?limit=5&momentumClass=rising&minScore=0.5
```

### Batch Protocol Scores

```http
POST /api/momentum/protocols/batch
Content-Type: application/json

{
  "protocolNames": ["Blend", "Soroswap", "Aquarius"],
  "timestamp": 1640995200000
}
```

### Configuration

```http
GET /api/momentum/config
POST /api/momentum/config
```

**Configuration Options:**
```json
{
  "windows": [
    { "name": "short", "durationMs": 86400000, "weight": 0.5 },
    { "name": "medium", "durationMs": 604800000, "weight": 0.3 },
    { "name": "long", "durationMs": 2592000000, "weight": 0.2 }
  ],
  "minDataPoints": 3,
  "confidenceWeight": 0.3,
  "liquidityWeight": 0.2,
  "riskPenaltyFactor": 0.15,
  "volatilityPenalty": 0.1,
  "consistencyBonus": 0.05
}
```

## Momentum Calculation

### Window Analysis

For each time window (short, medium, long):

1. **Filter snapshots** within the window timeframe
2. **Calculate trends** using linear regression:
   - APY trend (-1 to 1)
   - TVL trend (-1 to 1) 
   - Confidence trend (-1 to 1)
3. **Calculate volatility** (coefficient of variation)
4. **Calculate consistency** (inverse of volatility)
5. **Combine into momentum score** (0 to 1)

### Trend Calculation

```typescript
// Linear regression slope normalized to relative change
const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
const relativeSlope = (slope * (n - 1)) / avgY;
const trend = Math.max(-1, Math.min(1, relativeSlope));
```

### Momentum Combination

```typescript
// Weighted combination of trends
const weightedTrend = (
  apyTrend * 0.6 +
  tvlTrend * 0.25 +
  confidenceTrend * 0.15
);

// Apply consistency bonus
const momentum = (weightedTrend + 1) / 2 + consistency * consistencyBonus;
```

### Final Score Calculation

```typescript
// 1. Calculate weighted overall momentum
const overallMomentum = (
  shortMomentum * 0.5 +
  mediumMomentum * 0.3 +
  longMomentum * 0.2
);

// 2. Apply confidence adjustment
const confidenceAdjusted = overallMomentum * (
  1 + (confidence - 0.5) * confidenceWeight
);

// 3. Apply liquidity adjustment
const liquidityAdjusted = confidenceAdjusted * (
  1 + (liquidityScore - 0.5) * liquidityWeight
);

// 4. Apply risk penalty
const riskAdjustment = Math.max(0, 1 - riskScore * riskPenaltyFactor);

// 5. Apply volatility penalty
const volatilityPenalty = avgVolatility * volatilityPenalty;

// 6. Final score
const finalScore = Math.max(0, Math.min(1, 
  liquidityAdjusted * riskAdjustment - volatilityPenalty
));
```

## Momentum Classification

- **Rising**: `overallMomentum > 0.6`
- **Flat**: `0.4 <= overallMomentum <= 0.6`
- **Declining**: `overallMomentum < 0.4`

## Integration Points

### Analytics Dashboard

The momentum engine integrates with the analytics dashboard to provide:

- Real-time opportunity rankings
- Momentum trend visualizations
- Risk-adjusted recommendations
- Historical performance analysis

### Ranking System

Momentum scores are exposed in ranking and analytics views:

```typescript
// Get top opportunities
const analysis = await fetch('/api/momentum/ranking?limit=10&momentumClass=rising');

// Display in UI
analysis.data.opportunities.forEach(opp => {
  console.log(`${opp.protocolName}: ${opp.finalScore} (${opp.momentumClass})`);
});
```

### Risk Integration

The momentum engine respects hard risk exclusions:

```typescript
// Risk exclusions are applied before final scoring
if (protocol.isExcluded || protocol.riskScore > maxRiskThreshold) {
  // Protocol is filtered out regardless of momentum
  return null;
}
```

## Testing

### Test Cases

The momentum engine includes comprehensive tests covering:

- **Rising trends**: Protocols with increasing APY, TVL, and confidence
- **Declining trends**: Protocols with decreasing metrics
- **Flat trends**: Stable protocols with minimal change
- **Edge cases**: Zero values, extreme volatility, insufficient data
- **Performance**: Large datasets (1000+ snapshots)

### Test Coverage

- **Minimum 90% coverage** required
- **Property-based testing** for trend calculations
- **Integration tests** for API endpoints
- **Performance benchmarks** for large datasets

### Running Tests

```bash
# Run momentum engine tests
npm test -- --testPathPatterns=opportunityMomentumEngine.test.ts

# Run with coverage
npm test -- --testPathPatterns=opportunityMomentumEngine.test.ts --coverage

# Performance test with large dataset
npm test -- --testPathPatterns=opportunityMomentumEngine.test.ts --testNamePattern="large datasets"
```

## Configuration Guidelines

### Window Configuration

- **Short window (1 day)**: Captures immediate momentum changes
- **Medium window (7 days)**: Smooths out daily volatility
- **Long window (30 days)**: Identifies sustained trends

### Weight Tuning

- **Short weight (0.5)**: Emphasizes recent momentum
- **Medium weight (0.3)**: Balances recent and historical
- **Long weight (0.2)**: Provides stability context

### Risk Parameters

- **Risk penalty factor (0.15)**: Moderate penalty for high-risk protocols
- **Volatility penalty (0.1)**: Light penalty for volatile protocols
- **Consistency bonus (0.05)**: Small bonus for stable protocols

## Monitoring and Maintenance

### Health Monitoring

```http
GET /api/momentum/health
```

Monitor:
- Total protocols tracked
- Average snapshots per protocol
- Analysis performance
- Configuration drift

### Data Management

- **Automatic cleanup**: Snapshots older than 90 days are removed
- **Memory management**: Efficient storage of historical data
- **Bulk operations**: Support for large snapshot imports

### Performance Optimization

- **Lazy calculation**: Momentum scores calculated on-demand
- **Caching**: Results cached for repeated queries
- **Batch processing**: Efficient bulk analysis operations

## Security Considerations

### Input Validation

- Snapshot structure validation
- Timestamp range validation
- Protocol name sanitization
- Numeric value bounds checking

### Rate Limiting

- API endpoints should be rate-limited
- Bulk operations require appropriate permissions
- Configuration changes require admin access

### Data Integrity

- Immutable historical snapshots
- Audit logging for configuration changes
- Backup and recovery procedures

## Future Enhancements

### Advanced Features

1. **Machine Learning Integration**: ML-based trend prediction
2. **Cross-Protocol Correlation**: Analyze protocol interactions
3. **Market Regime Detection**: Adapt to different market conditions
4. **Real-time Streaming**: Live momentum updates

### Scalability Improvements

1. **Distributed Processing**: Scale across multiple nodes
2. **Time-series Database**: Optimize for historical data storage
3. **Caching Layer**: Redis-based result caching
4. **API Optimization**: GraphQL for flexible queries

## Troubleshooting

### Common Issues

1. **Insufficient Data**: Ensure minimum data points are met
2. **Stale Snapshots**: Check data ingestion pipeline
3. **Configuration Errors**: Validate weight sums and ranges
4. **Performance Issues**: Monitor snapshot count and cleanup

### Debug Tools

```bash
# Check protocol data
curl /api/momentum/protocols

# Verify configuration
curl /api/momentum/config

# Health check
curl /api/momentum/health

# Clear problematic data
curl -X DELETE /api/momentum/history
```

## Related Documentation

- [Analytics Contract Testing](./analytics-contract-testing.md)
- [Stale Data Troubleshooting](./stale-data-troubleshooting.md)
- [Backend Testing Guide](./backend_testing.md)