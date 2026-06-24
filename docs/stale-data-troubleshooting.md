# Stale Data Troubleshooting Guide

This guide explains how to identify, understand, and troubleshoot stale data states in StellarYield's yield cards and dashboard components.

## What is Stale Data?

Stale data refers to yield information that is outdated beyond acceptable freshness thresholds. The UI uses a confidence-based system to determine data freshness and automatically filters out unusable stale data.

## Freshness Thresholds

The system uses the following time-based thresholds for data freshness:

### Default Freshness Policy

- **Fresh Window**: 1 minute (60,000ms)
  - Data is considered 100% fresh and reliable
  - No visual indicators shown

- **Soft Stale Window**: 10 minutes (600,000ms)
  - Data confidence decays exponentially from 100% to near 0%
  - Visual "stale" indicators appear in the UI
  - Data is still usable but marked as potentially outdated

- **Hard Stale Threshold**: 45 minutes (2,700,000ms)
  - Data is considered unusable and filtered out completely
  - Cards/entries are hidden from the dashboard
  - `unusableDueToStale: true` flag is set

### Confidence Calculation

The system uses an exponential decay curve with decay constant `k = 3.5`:

```typescript
confidence = Math.exp(-3.5 * normalizedAge)
```

Where `normalizedAge` is the proportion of time elapsed in the soft stale window.

## Visual Indicators

### In Card View

- **Fresh Data**: No special indicators, shows "Updated just now (X% confidence)"
- **Stale Data**: Red clock icon with "Stale Data (Xm old)" badge
- **Filtered Data**: Cards are completely hidden from view

### In Table View

- **Fresh Data**: No special indicators
- **Stale Data**: Small red "STALE" badge next to the protocol name
- **Filtered Data**: Rows are completely hidden from view

## Common Causes of Stale Data

### 1. Backend Service Issues

**Symptoms**: All protocols showing stale data simultaneously

**Likely Causes**:
- Yield aggregation service is down or failing
- Database connection issues
- API rate limiting from external protocol APIs
- Network connectivity problems

**Debugging Steps**:
```bash
# Check backend health
curl http://localhost:3001/api/health

# Check yield endpoint directly
curl http://localhost:3001/api/yields

# Check backend logs for errors
docker logs stellaryield-backend
```

### 2. Protocol-Specific Data Issues

**Symptoms**: Only specific protocols showing stale data

**Likely Causes**:
- Individual protocol API is down or rate-limited
- Protocol smart contract changes breaking data fetching
- Specific protocol excluded due to risk assessment

**Debugging Steps**:
```bash
# Check specific protocol data
curl "http://localhost:3001/api/yields?protocol=Blend"

# Check protocol compatibility
curl "http://localhost:3001/api/analytics/compatibility/Blend"
```

### 3. Caching Issues

**Symptoms**: Data appears stale despite recent backend updates

**Likely Causes**:
- Browser cache holding old data
- CDN cache not invalidated
- Backend cache not refreshing properly

**Debugging Steps**:
```bash
# Force refresh without cache
Ctrl+Shift+R (or Cmd+Shift+R on Mac)

# Clear backend cache for specific wallet
curl -X DELETE "http://localhost:3001/api/analytics/attribution/cache/WALLET_ADDRESS"
```

### 4. Timestamp Issues

**Symptoms**: Data appears stale immediately after fetching

**Likely Causes**:
- Server clock drift
- Timezone mismatches
- Incorrect `fetchedAt` timestamp format

**Debugging Steps**:
```bash
# Check server time
curl -I http://localhost:3001/api/health

# Verify timestamp format in API response
curl http://localhost:3001/api/yields | jq '.[0].fetchedAt'
```

## API Endpoints for Debugging

### Health Check
```bash
GET /api/health
```
Returns overall system health and timestamp.

### Yield Data
```bash
GET /api/yields
```
Returns all yield data with `fetchedAt` timestamps.

### Analytics Health
```bash
GET /api/analytics/health/:strategyId
```
Returns health metrics for specific strategies.

### Cache Management
```bash
DELETE /api/analytics/attribution/cache/:walletAddress
```
Clears cached attribution data for a wallet.

## Configuration

### Frontend Freshness Policy

Located in `client/src/components/dashboard/freshnessDecay.ts`:

```typescript
export const DEFAULT_UI_FRESHNESS_POLICY: FreshnessPolicy = {
  curve: "exponential",
  freshWindowMs: 60_000,      // 1 minute
  softStaleMs: 10 * 60_000,   // 10 minutes
  hardStaleMs: 45 * 60_000,   // 45 minutes
  decayK: 3.5,                // Exponential decay constant
};
```

### Backend Refresh Intervals

Check the following configuration files:
- `server/src/config/` - Service configuration
- `server/src/jobs/` - Scheduled job intervals
- Environment variables for API timeouts

## User-Facing Terminology

The dashboard uses consistent terminology for data freshness states:

- **"Updated just now"** - Data is fresh (< 1 minute old)
- **"Stale Data (Xm old)"** - Data is stale but usable (1-45 minutes old)
- **Hidden/Filtered** - Data is too stale to display (> 45 minutes old)
- **"X% confidence"** - Numerical confidence score based on age

## Troubleshooting Checklist

1. **Check System Health**
   - [ ] Backend `/api/health` endpoint responds
   - [ ] Frontend loads without errors
   - [ ] No network connectivity issues

2. **Verify Data Sources**
   - [ ] External protocol APIs are accessible
   - [ ] Database connections are healthy
   - [ ] Scheduled jobs are running

3. **Check Timestamps**
   - [ ] Server time is accurate
   - [ ] `fetchedAt` timestamps are recent
   - [ ] Timezone handling is correct

4. **Clear Caches**
   - [ ] Browser cache cleared
   - [ ] Backend cache cleared if needed
   - [ ] CDN cache invalidated

5. **Monitor Logs**
   - [ ] Backend error logs checked
   - [ ] Frontend console errors reviewed
   - [ ] External API rate limiting monitored

## Related Components

- `client/src/components/dashboard/ApyDashboard.tsx` - Main yield dashboard
- `client/src/components/dashboard/freshnessDecay.ts` - Freshness calculation logic
- `server/src/routes/analytics.ts` - Backend analytics endpoints
- `server/src/services/` - Data aggregation services

## Recommendations Failover and Warnings System (Backend)

To prevent stale or unhealthy yield sources from being recommended on the platform:

1. **Leaderboard Filtering**:
   - The recommendations engine (`/api/strategies/leaderboard`) filters out yield sources using `protocolFailoverService`.
   - Data older than 5 minutes (`maxDataAgeMs`) is automatically classified as stale and excluded from the leaderboard ranking.
   - Unhealthy states (e.g., status is `"critical"` or `"down"`) automatically trigger failover exclusion.

2. **Explicit Warning Propagation**:
   - The `/api/strategies/leaderboard` endpoint returns a top-level `warnings` array listing degraded or excluded sources.
   - The `/api/yields` endpoint returns `isStale` (boolean), `reliabilityStatus` (string), and `warnings` (array of strings) properties for each protocol entry.

## Support

For persistent stale data issues:

1. Check the [backend testing guide](./backend_testing.md) for API debugging
2. Review the [contributor guide](./contributor-guide.md) for development setup
3. File an issue with specific error messages and timestamps