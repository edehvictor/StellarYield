# @stellaryield/sdk

TypeScript SDK for building on top of StellarYield vaults. Provides typed wrappers for vault contract interactions and backend API endpoints.

## Installation

```bash
npm install @stellaryield/sdk
```

## Quick Start

### Vault Operations

Every state-changing call (`deposit`, `withdraw`, `harvest`, `rebalance`, `emergencyWithdraw`) returns a `PreparedTransaction`, not a resolved value — drive it through the transaction lifecycle yourself (`simulate` happens during `prepare()`, then `sign` -> `submit` -> `poll`/`wait`):

```typescript
import { VaultClient, ServerKeypairSigner } from '@stellaryield/sdk';

const vault = new VaultClient({
  contractId: 'CACT...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

const signer = ServerKeypairSigner.fromSecret('S...');
const from = await signer.getPublicKey();

// Deposit tokens into the vault
const prepared = await vault.deposit.prepare({
  from,
  amount: 1_000_000_000n,
  min_shares_out: 990_000_000n, // 1% slippage tolerance
});
const signed = await prepared.sign(signer);
const submitted = await signed.submit(vault.rpcUrl);
const confirmed = await submitted.wait();
console.log(`Minted ${confirmed.result} shares in ledger ${confirmed.ledger}`);

// Check your balance
const myShares = await vault.getShares(from);

// Withdraw by burning shares
const withdrawal = await (await vault.withdraw.prepare({ to: from, shares: myShares }))
  .sign(signer);
const withdrawn = await (await withdrawal.submit(vault.rpcUrl)).wait();
```

If a simulation reports expired ledger entries, it throws `RestoreRequiredError` (`error.restorePreamble`) — pass that into the exported `restoreAndRetry()` helper, then retry `prepare()`. See `src/examples/basic.ts` for a full worked example including the restore path.

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
  - `deposit.prepare()`, `withdraw.prepare()`, `harvest.prepare()`, `rebalance.prepare()`, `emergencyWithdraw.prepare()`: build+simulate a `PreparedTransaction`
  - `getShares()`: Check user share balance
  - `totalShares()`, `totalAssets()`: Vault metrics
  - `getAdmin()`, `getToken()`, `getFlashLoanFee()`: Read-only contract state
  - `recoverTransaction(hash)`: Resume polling a previously submitted transaction

- **Lifecycle helpers**: `PreparedTransaction` -> `.sign()` -> `SignedTransaction` -> `.submit()` -> `SubmittedTransaction` -> `.wait()` -> `ConfirmedTransaction`, plus `restoreAndRetry()`/`needsRestore()` for the Soroban footprint-restore path. Errors carry a `phase` (`simulate`/`sign`/`submit`/`poll`/`restore`) and `retryable` flag.

- **ApiClient**: Fetch vault metrics from backend
  - `getCurrentAPY()`: Get current APY
  - `getTVL()`: Get Total Value Locked
  - `getHistoricalData()`: Get APY/TVL history
  - `getVaultData()`: Get complete vault data

## License

MIT
