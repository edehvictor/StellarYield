# @stellaryield/sdk

TypeScript SDK for building on top of StellarYield vaults. Provides typed wrappers for vault contract interactions and backend API endpoints.

## Installation

```bash
npm install @stellaryield/sdk
```

## Quick Start

### Vault Operations

```typescript
import { VaultClient } from '@stellaryield/sdk';

const vault = new VaultClient({
  contractId: 'CACT...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

// Deposit tokens into the vault
const shares = await vault.deposit({
  from: 'GB...',
  amount: '1000000000',
  minSharesOut: '990000000', // 1% slippage tolerance
});

// Check your balance
const myShares = await vault.getShares('GB...');

// Withdraw by burning shares
const amount = await vault.withdraw({
  to: 'GB...',
  shares: '500000000',
});
```

### API Client

```typescript
import { ApiClient } from '@stellaryield/sdk';

const api = new ApiClient({
  baseUrl: 'https://api.stellaryield.io',
});

// Get current APY
const apy = await api.getCurrentAPY('vault-contract-id');

// Get historical data
const history = await api.getHistoricalData('vault-contract-id', 30);

// Get complete vault data
const vaultData = await api.getVaultData('vault-contract-id');
```

## Features

- **VaultClient**: Interact with YieldVault Soroban contract
  - `deposit()`: Deposit tokens and receive shares
  - `withdraw()`: Burn shares to receive tokens
  - `getShares()`: Check user share balance
  - `totalShares()`, `totalAssets()`: Vault metrics
  - `convertToShares()`, `convertToAssets()`: Price conversions
  - `previewDeposit()`: Preview deposit outcome

- **ApiClient**: Fetch vault metrics from backend
  - `getCurrentAPY()`: Get current APY
  - `getTVL()`: Get Total Value Locked
  - `getHistoricalData()`: Get APY/TVL history
  - `getVaultData()`: Get complete vault data

## License

MIT
