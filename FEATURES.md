# StellarYield Feature Suite

This document describes the four major features implemented in this release.

## #149 Fiat Off-Ramp Integration ("Zap-Out to Bank")

**Location:** `client/src/features/offramp/`

### Overview

One-click withdrawals from vault shares directly to user bank accounts via MoonPay or Stellar Anchor integration.

### Components

- `OffRampPanel.tsx` - Main UI for withdrawal flow
- `offRampService.ts` - Service layer handling off-ramp provider integration
- `types.ts` - TypeScript interfaces

### Key Features

- Vault shares → USDC → fiat wire conversion
- Real-time transaction status tracking
- Strict memo/address validation to prevent fund loss
- Transaction history with status indicators
- Support for multiple off-ramp providers

### Usage

```tsx
import { OffRampPanel } from "@/features/offramp";

<OffRampPanel
  walletAddress={address}
  vaultContractId={vaultId}
  vaultTokenSymbol="USDC"
/>;
```

### Testing

- 90%+ coverage with unit tests
- Validates bank account format
- Tests memo generation and validation
- Tests transaction persistence

---

## #148 Drag-and-Drop Multi-Vault Portfolio Builder

**Location:** `client/src/features/portfolio_builder/`

### Overview

Power users can allocate capital across 3-4 vaults simultaneously with real-time blended APY projection.

### Components

- `PortfolioBuilder.tsx` - Main UI with drag sliders
- `portfolioUtils.ts` - Allocation calculations and validation
- `types.ts` - TypeScript interfaces

### Key Features

- Drag-slider allocation UI (0-100% per vault)
- Real-time blended APY calculation
- Automatic weight normalization to 100%
- Floating-point rounding error prevention
- Batched XDR transaction support
- Multi-step transaction timeline

### Usage

```tsx
import { PortfolioBuilder } from "@/features/portfolio_builder";

<PortfolioBuilder
  walletAddress={address}
  availableVaults={[
    { contractId: "vault1", name: "Vault A", apy: 10 },
    { contractId: "vault2", name: "Vault B", apy: 8 },
  ]}
/>;
```

### Utilities

```typescript
// Calculate blended APY from allocations
const apy = calculateBlendedApy(allocations);

// Validate allocations sum to 100%
const isValid = isValidAllocation(allocations);

// Distribute total amount across allocations
const distributed = distributeAmount(totalAmount, allocations);

// Normalize weights to exactly 100%
const normalized = normalizeWeights(allocations);
```

### Testing

- 90%+ coverage with unit tests
- Tests weight validation and normalization
- Tests amount distribution with rounding
- Tests three-vault scenarios

---

## #135 Yield Strategy Backtester & APY Simulator UI

**Location:** `client/src/features/simulator/`

### Overview

Users can input a hypothetical deposit date and amount to see PnL based on historical data.

### Components

- `BacktestPanel.tsx` - Main UI with date inputs and results
- `backtestService.ts` - Backtest calculation and API integration
- `types.ts` - TypeScript interfaces

### Key Features

- Date range input with validation
- Compound interest calculation from historical APY snapshots
- Interactive charting interface (placeholder for Recharts)
- Equity curve visualization
- APY history timeline
- Total return percentage calculation

### Backend Endpoints

- `GET /api/backtest` - Run backtest with date range and deposit amount
  - Validates date inputs to prevent heavy queries
  - Limits query range to 2 years
  - Returns daily snapshots with equity values

### Usage

```tsx
import { BacktestPanel } from "@/features/simulator";

<BacktestPanel vaultContractId={vaultId} vaultName="Vault A" />;
```

### Testing

- 90%+ coverage with unit tests
- Tests compound interest calculation
- Tests date validation
- Tests total return calculation

---

## #150 Google Sheets / CSV Data Sync via OAuth

**Location:** `client/src/features/google_sheets/`

### Overview

Institutional users can authorize the app to automatically push daily yield metrics to a Google Sheet.

### Components

- `GoogleSheetsPanel.tsx` - Settings UI for account linking
- `googleSheetsService.ts` - OAuth and Sheets API integration
- `types.ts` - TypeScript interfaces

### Key Features

- Google OAuth2 authentication flow
- Spreadsheet linking with verification
- Nightly cron job for metric sync
- Encrypted refresh token storage
- Account unlinking
- Session management with expiration

### Backend Endpoints

- `POST /api/google-sheets/token` - Exchange auth code for tokens
  - Securely stores encrypted refresh tokens
  - Returns access token and email

- `POST /api/google-sheets/verify` - Verify spreadsheet access
  - Validates user can access spreadsheet
  - Checks sheet exists

- `POST /api/google-sheets/append` - Append daily metrics
  - Appends rows: date, vault, deposit, value, yield, APY
  - Runs nightly via cron job

### Usage

```tsx
import { GoogleSheetsPanel } from "@/features/google_sheets";

<GoogleSheetsPanel walletAddress={address} />;
```

### Synced Metrics

Each row contains:

- Date (YYYY-MM-DD)
- Vault name
- Deposit amount (USDC)
- Current value (USDC)
- Daily yield (USDC)
- APY (%)

### Testing

- 90%+ coverage with unit tests
- Tests OAuth URL generation
- Tests token expiration detection
- Tests spreadsheet ID validation

---

## Testing & Coverage

All features include comprehensive test suites:

### Frontend Tests

```bash
npm run test -- --coverage
```

Test files:

- `client/src/features/offramp/OffRampPanel.test.ts`
- `client/src/features/portfolio_builder/portfolioUtils.test.ts`
- `client/src/features/simulator/backtestService.test.ts`
- `client/src/features/google_sheets/googleSheetsService.test.ts`

### Backend Tests

```bash
cd backend/keepers && npm run test -- --coverage
```

Test files:

- `backend/keepers/src/__tests__/backtest.test.ts`
- `backend/keepers/src/__tests__/googleSheets.test.ts`

---

## Environment Variables

### Frontend (.env)

```
VITE_OFFRAMP_API_KEY=your_moonpay_key
VITE_OFFRAMP_BASE_URL=https://api.moonpay.com
VITE_GOOGLE_CLIENT_ID=your_google_client_id
VITE_GOOGLE_CLIENT_SECRET=your_google_client_secret
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

### Backend (.env)

```
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
STELLAR_NETWORK=testnet
VAULT_CONTRACT_ID=your_vault_contract_id
```

---

## Architecture Patterns

All features follow StellarYield conventions:

### State Management

- React hooks for local state
- localStorage for persistence
- Context for global state

### Transaction Phases

- `idle` → `building` → `simulating` → `waiting_for_wallet` → `submitting` → `polling` → `success`/`failure`
- `TxStatusTimeline` component for UI

### Error Handling

- Try-catch with user-friendly messages
- Error state in components
- Retry buttons for failed operations

### Styling

- Tailwind CSS with glassmorphism utilities
- `.glass-panel` for card backgrounds
- CSS variables for theme colors

---

## Security Considerations

### Off-Ramp

- Strict memo/address validation
- Prevents fund loss in transit
- Sanitizes user input

### Portfolio Builder

- Floating-point validation
- Prevents rounding errors in transactions
- Validates weight sum to 100%

### Google Sheets

- OAuth refresh tokens encrypted at rest
- Secure token exchange
- Spreadsheet access verification
- Session expiration handling

---

## Future Enhancements

1. **Off-Ramp**: Add support for additional providers (Stripe, Wise)
2. **Portfolio**: Implement drag-and-drop UI with Framer Motion
3. **Backtester**: Add Recharts visualization with interactive tooltips
4. **Google Sheets**: Add CSV export and import functionality

---

## Support

For issues or questions about these features, please refer to the main README.md or open an issue on GitHub.
