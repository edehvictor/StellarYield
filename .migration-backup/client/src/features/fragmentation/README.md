# Liquidity Fragmentation Analyzer - Frontend Dashboard

This feature provides a comprehensive dashboard for monitoring liquidity fragmentation across Stellar DeFi protocols (Blend, Soroswap, DeFindex, Aquarius).

## Components

### FragmentationDashboard (Main Component)
The main dashboard component that orchestrates all sub-components and handles API integration.

**Features:**
- Auto-refresh with configurable interval (default: 60 seconds)
- Loading and error states
- Real-time data fetching from `/api/liquidity/fragmentation`

**Props:**
- `refreshInterval?: number` - Auto-refresh interval in milliseconds (default: 60000)
- `showRecommendations?: boolean` - Show/hide routing recommendations (default: true)

### FragmentationScoreCard
Displays the fragmentation score (0-100) with visual indicators.

**Color Coding:**
- Low (<30): Green
- Medium (30-60): Yellow
- High (>60): Red

### ExecutionQualityCard
Shows execution quality score with color-coded gauge.

**Color Coding:**
- Good (>70): Green
- Fair (50-70): Yellow
- Poor (<50): Red

**Features:**
- Material impact warning when score < 70

### EffectiveProtocolsCard
Displays effective protocol count, HHI, and multi-protocol routing percentage.

**Features:**
- Tooltip explanation for HHI (Herfindahl-Hirschman Index)

### MaterialImpactWarning
Warning banner shown when material impact is detected (execution quality < 70).

**Features:**
- Recommended routing strategy
- Alternative suggestions
- Reasoning explanation
- Dismissible

### ProtocolDistributionChart
Horizontal bar chart showing TVL distribution across protocols.

**Features:**
- Sorted by TVL share (descending)
- Highlights deepest liquidity protocol with star icon
- Shows execution impact per protocol
- Responsive design

### RoutingRecommendations
Displays routing recommendations based on fragmentation level.

**Features:**
- Recommended strategy (single-protocol vs multi-protocol)
- Deepest liquidity protocol identification
- Alternative suggestions
- Analysis reasoning

### DataFreshnessIndicator
Shows data freshness and completeness status.

**Features:**
- Last update timestamp
- Next update countdown (live)
- Data completeness warnings
- Stale data indicators
- Missing protocol alerts

## Usage

```tsx
import { FragmentationDashboard } from './features/fragmentation';

// Basic usage
<FragmentationDashboard />

// Custom refresh interval (2 minutes)
<FragmentationDashboard refreshInterval={120000} />

// Hide recommendations
<FragmentationDashboard showRecommendations={false} />
```

## API Integration

The dashboard fetches data from:
```
GET /api/liquidity/fragmentation
```

**Expected Response:**
```typescript
{
  success: boolean;
  data: {
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
    routingRecommendation: RoutingRecommendation;
    timestamp: string;
    nextUpdateAt: string;
  };
  meta: {
    cacheStatus: 'HIT' | 'MISS';
    computeTimeMs: number;
    nextUpdateAt: string;
  };
}
```

## Routing

The dashboard is accessible at:
```
/fragmentation
```

Navigation link added to main menu with Network icon.

## Design System

All components follow the existing design system:
- Uses `glass-card` and `glass-panel` classes
- Consistent color palette (indigo, purple, green, yellow, red)
- Responsive grid layouts
- Smooth transitions and animations
- Loading skeletons
- Error handling with dismissible banners

## Requirements Fulfilled

- ✅ 4.1: Display fragmentation score with visual indicators
- ✅ 4.2: Display execution quality score with color-coded status
- ✅ 4.3: Material impact warning when detected
- ✅ 4.4: Protocol distribution breakdown
- ✅ 4.5: Data freshness indicators
- ✅ 5.1-5.5: Threshold categorization and visual indicators
- ✅ 8.1-8.4: Routing recommendations
- ✅ Auto-refresh functionality
- ✅ Loading and error states
- ✅ Responsive design

## Future Enhancements

Optional tasks not implemented in MVP:
- Unit tests for React components (14.10)
- Integration tests (15.2)

These can be added in future iterations for improved test coverage.
