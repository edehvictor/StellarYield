# Yield Calculator Component

A highly interactive compound interest calculator for visualizing wealth growth through yield farming.

## Features

- **Daily Compounding**: Accurate compound interest calculations with daily compounding intervals
- **Interactive Sliders**: Real-time parameter adjustment with smooth UI feedback
- **Dynamic Visualization**: Interactive area chart showing growth projections
- **Comparison Lines**: Visual comparison between yield farming, simple interest, and principal-only scenarios
- **Timeframe Selection**: Quick switching between 1, 5, and 10 year views
- **Comprehensive Metrics**: Final value, contributions, interest earned, and return percentages
- **Responsive Design**: Optimized for desktop and mobile devices
- **Error Handling**: Input validation with user-friendly error messages

## Components

### `compoundMath.ts`

Core mathematical utilities for compound interest calculations:

- `calculateCompoundProjection()` - Main calculation engine
- `calculateProjectionMetrics()` - Extracts key metrics from projections
- `formatCurrency()` - Currency formatting utilities
- `formatPercentage()` - Percentage formatting utilities
- `validateConfig()` - Input validation

### `YieldCalculator.tsx`

Main React component with:

- Interactive parameter sliders
- Real-time chart updates
- Metrics display cards
- Timeframe selection
- Responsive layout

## Usage

```tsx
import { YieldCalculator } from '@/components/calculator';

function MyComponent() {
  return <YieldCalculator />;
}
```

## Mathematical Formula

The calculator uses the compound interest formula with daily compounding:

```
A = P(1 + r/n)^(nt) + PMT × [((1 + r/n)^(nt) - 1) / (r/n)]
```

Where:
- A = Final amount
- P = Principal amount
- r = Annual interest rate (decimal)
- n = Number of times interest is compounded per year (365)
- t = Time in years
- PMT = Monthly payment amount

## Input Parameters

- **Initial Deposit**: $0 - $100,000
- **Monthly Addition**: $0 - $10,000
- **Annual APY**: 0% - 30%
- **Time Horizon**: 1 - 30 years

## Output Metrics

- **Final Value**: Total value after compound growth
- **Total Contributed**: Sum of all deposits
- **Interest Earned**: Total profit from yield farming
- **Total Return**: Percentage return on investment
- **Annualized Return**: Equivalent annual return rate

## Testing

Run tests with:

```bash
npm test -- calculator
```

Coverage includes:
- Mathematical accuracy tests
- Edge case handling
- Component interaction tests
- Error validation tests
- Accessibility tests

## Styling

The component uses Tailwind CSS with custom glass-morphism effects:
- `glass-card` - Main container styling
- `glass-panel` - Alternative panel styling
- Responsive grid layouts
- Custom slider styling
- Gradient chart fills

## Dependencies

- React 18+
- Recharts for data visualization
- Lucide React for icons
- Tailwind CSS for styling

## Performance

- Memoized calculations prevent unnecessary recomputation
- Efficient chart data transformation
- Optimized re-rendering with proper state management
- Lightweight mathematical operations

## Accessibility

- Semantic HTML structure
- Proper ARIA labels
- Keyboard navigation support
- Screen reader compatibility
- High contrast color scheme
