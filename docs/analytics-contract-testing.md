# Analytics Contract Testing Guide

This guide documents the contract testing approach for StellarYield's analytics endpoints, ensuring API response structures remain stable across backend changes.

## Overview

Contract tests validate that analytics endpoints return responses with expected structures, field types, and value ranges. They protect frontend components from breaking changes in backend API responses.

## Test Coverage

### Endpoints Tested

1. **Portfolio Attribution** (`/api/analytics/attribution/:walletAddress`)
2. **Protocol Compatibility** (`/api/analytics/compatibility`)
3. **Strategy Health** (`/api/analytics/health/:strategyId`)
4. **Yield Reliability** (`/api/analytics/reliability/:providerId`)
5. **Combined Dashboard** (`/api/analytics/dashboard`)
6. **State Transitions** (`/api/analytics/strategy-state-transitions/:strategyId`)
7. **Recommendation Stability** (`/api/analytics/recommendation-stability/compare`)

### Test Files

- `src/__tests__/analyticsRoutes.simple.test.ts` - Contract structure validation
- `src/__tests__/fixtures/analyticsMockData.ts` - Deterministic mock data generators

## Response Structure Contracts

### Attribution Report Response

```typescript
{
  success: boolean;
  data: {
    walletAddress: string;
    totalReturn: number;
    totalDeposited: number;
    attributionBreakdown: Array<{
      decisionType: string;
      contribution: number;
      percentage: number; // 0-100
      apyImpact: number;
      decisions: Array<Decision>;
      confidence: number; // 0-1
    }>;
    rewardSourceMix?: Array<{
      rewardSource: string;
      contribution: number;
      percentage: number;
      confidence: number;
    }>;
    timeWindow: {
      start: string; // ISO timestamp
      end: string;   // ISO timestamp
    };
    generatedAt: string; // ISO timestamp
    dataCompleteness: number; // 0-1
    formattedDate: string; // ISO timestamp
    totalAttribution: number;
  };
}
```

### Compatibility Report Response

```typescript
{
  success: boolean;
  data: {
    protocols: Array<{
      protocolName: string;
      status: 'compatible' | 'degraded' | 'incompatible';
      criticalIssues: number;
      lastChecked: string; // ISO timestamp
      version?: string;
      supportedFeatures?: string[];
    }>;
    issues: Array<{
      severity: 'critical' | 'warning' | 'info';
      protocol: string;
      message: string;
      code?: string;
      timestamp: string; // ISO timestamp
    }>;
    overallStatus: 'compatible' | 'degraded' | 'incompatible';
    generatedAt: string; // ISO timestamp
    checkDuration: number; // milliseconds
    formattedDate: string; // ISO timestamp
    criticalIssues: Array<Issue>; // Filtered critical issues
  };
}
```

### Health Score Response

```typescript
{
  success: boolean;
  data: {
    strategyId: string;
    strategyName: string;
    overallScore: number; // 0-100
    metrics: {
      contractSafety: number;
      dataFreshness: number;
      providerUptime: number;
      liquidityConditions: number;
      executionOutcomes: number;
      volatilityIndex: number;
      errorRate: number;
      latency: number;
    };
    status: 'healthy' | 'degraded' | 'critical' | 'disabled';
    signals: Array<HealthSignal>;
    lastUpdated: string; // ISO timestamp
    trend: 'improving' | 'stable' | 'declining';
    recommendations: string[];
    suppressUntil?: string; // ISO timestamp
    formattedDate: string; // ISO timestamp
  };
}
```

### Reliability Score Response

```typescript
{
  success: boolean;
  data: {
    providerId: string;
    providerName: string;
    overallScore: number; // 0-100
    dataSource: string;
    metrics: {
      uptime: number;
      accuracy: number;
      latency: number;
      errorRate: number;
      consistency: number;
    };
    historicalPerformance: Array<{
      timestamp: string;
      score: number;
      incidents: number;
    }>;
    lastUpdated: string; // ISO timestamp
    status: 'reliable' | 'moderate' | 'unreliable';
    formattedDate: string; // ISO timestamp
  };
}
```

### Dashboard Response

```typescript
{
  success: boolean;
  data: {
    attribution: AttributionReport | null;
    compatibility: CompatibilityReport | null;
    healthScores: HealthScore[];
    reliabilityScores: ReliabilityScore[];
    alerts: Alert[];
    summary: {
      overallHealth: 'healthy' | 'degraded' | 'critical' | 'unknown';
      criticalIssues: number;
      recommendations: string[];
      lastUpdated: string; // ISO timestamp
    };
  };
}
```

### Error Response

```typescript
{
  error: string;
  message: string;
}
```

## Field Validation Rules

### Timestamps
- Must be valid ISO 8601 strings
- Must be parseable by `Date.parse()`
- Format: `YYYY-MM-DDTHH:mm:ss.sssZ`

### Percentages
- Must be numbers between 0 and 100 (inclusive)
- Used for: `percentage`, `dataCompleteness * 100`

### Scores
- Must be numbers between 0 and 100 (inclusive)
- Used for: `overallScore`, metric values

### Confidence Values
- Must be numbers between 0 and 1 (inclusive)
- Used for: `confidence`, `dataCompleteness`

### Status Enums
- **Health Status**: `'healthy' | 'degraded' | 'critical' | 'disabled'`
- **Compatibility Status**: `'compatible' | 'degraded' | 'incompatible'`
- **Reliability Status**: `'reliable' | 'moderate' | 'unreliable'`
- **Trend**: `'improving' | 'stable' | 'declining'`
- **Severity**: `'critical' | 'warning' | 'info'`

## Deterministic Mock Data

The `analyticsMockData.ts` fixture provides consistent test data:

```typescript
// Generate deterministic attribution report
const report = AnalyticsMockDataGenerator.createAttributionReport('WALLET123');

// Generate compatibility report with known issues
const compatibility = AnalyticsMockDataGenerator.createCompatibilityReport();

// Generate health score for specific strategy
const health = AnalyticsMockDataGenerator.createHealthScore('strategy_1');
```

### Mock Data Features

- **Fixed timestamps** for reproducible tests
- **Deterministic values** based on input parameters
- **Edge case scenarios** (empty states, critical conditions)
- **Realistic data relationships** (scores affect status)

## Intentionally Unstable Fields

These fields are expected to change between test runs and should not be validated for exact values:

- `generatedAt` - Current timestamp when response is generated
- `lastUpdated` - Timestamp of last data update
- `formattedDate` - Formatted version of generation timestamp
- `checkDuration` - Time taken to perform checks (varies by system load)

## Running Contract Tests

```bash
# Run all analytics contract tests
npm test -- --testPathPatterns=analyticsRoutes.simple.test.ts

# Run with coverage
npm test -- --testPathPatterns=analyticsRoutes.simple.test.ts --coverage

# Run in watch mode during development
npm test -- --testPathPatterns=analyticsRoutes.simple.test.ts --watch
```

## Test Organization

### Structure Validation Tests
- Verify presence of required fields
- Validate nested object structures
- Check array types and contents

### Field Type Tests
- Validate primitive types (string, number, boolean)
- Check enum value constraints
- Verify timestamp format compliance

### Value Range Tests
- Ensure scores are within 0-100 range
- Validate percentages are 0-100
- Check confidence values are 0-1

### Empty State Tests
- Validate responses when no data is available
- Ensure arrays are empty rather than null
- Check default values for optional fields

### Error Handling Tests
- Validate error response structure
- Check error message format
- Ensure consistent error handling across endpoints

## Best Practices

### Writing Contract Tests

1. **Focus on Structure**: Test response shape, not business logic
2. **Use Type Guards**: Validate field types explicitly
3. **Test Edge Cases**: Include empty states and error conditions
4. **Avoid Brittle Tests**: Don't test exact values that may change
5. **Document Assumptions**: Clearly state what each test validates

### Mock Data Guidelines

1. **Deterministic Values**: Use fixed values for reproducible tests
2. **Realistic Relationships**: Ensure data relationships make sense
3. **Edge Cases**: Include boundary conditions and error states
4. **Minimal Data**: Use smallest dataset that validates structure

### Maintenance

1. **Update on Schema Changes**: Modify tests when API contracts change
2. **Version Documentation**: Track contract changes in release notes
3. **Backward Compatibility**: Consider impact on existing frontend code
4. **Regular Review**: Periodically review test coverage and relevance

## Integration with Frontend

Contract tests ensure frontend components can safely consume analytics data:

```typescript
// Frontend can rely on these structures being stable
interface AttributionPanelProps {
  data: AttributionReport; // Contract guaranteed structure
}

// Type-safe data access
const totalReturn = data.totalReturn; // Always a number
const breakdown = data.attributionBreakdown; // Always an array
```

## Troubleshooting

### Common Issues

1. **Type Mismatches**: Check if service types match utility function expectations
2. **Missing Fields**: Ensure all required fields are present in mock data
3. **Enum Violations**: Verify status values match allowed enum values
4. **Timestamp Formats**: Ensure ISO 8601 format compliance

### Debugging Tips

1. **Log Response Structure**: Use `console.log(JSON.stringify(response, null, 2))`
2. **Check Field Types**: Use `typeof` checks for primitive validation
3. **Validate Arrays**: Ensure arrays are not null and contain expected items
4. **Test Incrementally**: Start with basic structure, add field validation

## Related Documentation

- [Backend Testing Guide](./backend_testing.md) - API testing with curl
- [Stale Data Troubleshooting](./stale-data-troubleshooting.md) - Data freshness issues
- [Contributor Guide](./contributor-guide.md) - Development setup and testing