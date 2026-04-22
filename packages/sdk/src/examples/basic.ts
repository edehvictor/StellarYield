import { VaultClient, ApiClient } from "../index";

/**
 * Example: Basic vault operations
 */
async function basicVaultExample() {
  const vaultClient = new VaultClient({
    contractId: "CACTXW...(your vault contract ID)",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
  });

  const shares = await vaultClient.deposit({
    from: "GB...(your wallet address)",
    amount: "1000000000", // 100 units (7 decimals stroops)
    minSharesOut: "990000000", // Accept 1% slippage
  });

  console.log(`Deposited and received ${shares} shares`);

  const userShares = await vaultClient.getShares("GB...(your wallet address)");
  console.log(`User has ${userShares} shares`);

  const vaultInfo = await vaultClient.getInfo();
  console.log("Vault info:", vaultInfo);
}

/**
 * Example: API data retrieval
 */
async function apiExample() {
  const apiClient = new ApiClient({
    baseUrl: "https://api.stellaryield.io",
  });

  const apy = await apiClient.getCurrentAPY("vault-contract-id");
  console.log(`Current APY: ${apy}%`);

  const history = await apiClient.getHistoricalData("vault-contract-id", 30);
  console.log(`Last 30 days of data:`, history);

  const vaultData = await apiClient.getVaultData("vault-contract-id");
  console.log("Complete vault data:", vaultData);
}

/**
 * Example: Share price calculations
 */
async function shareCalculationsExample() {
  const vaultClient = new VaultClient({
    contractId: "CACT...",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
  });

  const assets = "1000000000";
  const shares = await vaultClient.convertToShares(assets);
  console.log(`${assets} assets = ${shares} shares`);

  const previewShares = await vaultClient.previewDeposit(assets);
  console.log(`Preview: depositing ${assets} would mint ${previewShares} shares`);
}

export { basicVaultExample, apiExample, shareCalculationsExample };
