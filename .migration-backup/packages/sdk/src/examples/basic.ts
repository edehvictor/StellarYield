import { rpc } from "@stellar/stellar-sdk";
import {
  VaultClient,
  ApiClient,
  ServerKeypairSigner,
  RestoreRequiredError,
  restoreAndRetry,
} from "../index";

/**
 * Example: full deposit lifecycle (simulate -> sign -> submit -> poll -> confirm).
 *
 * Every state-changing VaultClient method (deposit/withdraw/harvest/rebalance/
 * emergencyWithdraw) returns a `PreparedTransaction`, not a resolved value —
 * you drive it through `.sign()` -> `.submit()` -> `.wait()` yourself so any
 * wallet (a raw secret key here, Freighter, or a custom signer) can be used.
 */
async function depositExample() {
  const rpcUrl = "https://soroban-testnet.stellar.org";
  const networkPassphrase = "Test SDF Network ; September 2015";

  const vaultClient = new VaultClient({
    contractId: "CACTXW...(your vault contract ID)",
    networkPassphrase,
    rpcUrl,
  });

  const signer = ServerKeypairSigner.fromSecret("S...(your secret key)");
  const from = await signer.getPublicKey();

  let prepared = await vaultClient.deposit.prepare({
    from,
    amount: 1_000_000_000n, // 100 units (7-decimal stroops)
    min_shares_out: 990_000_000n, // accept up to 1% slippage
  });

  const signed = await prepared.sign(signer);
  const submitted = await signed.submit(rpcUrl);

  try {
    const confirmed = await submitted.wait();
    console.log(`Deposit confirmed in ledger ${confirmed.ledger}, minted ${confirmed.result} shares`);
  } catch (error) {
    if (error instanceof RestoreRequiredError && error.restorePreamble) {
      // Some ledger entries the deposit touches have expired; restore them
      // and then retry the original prepare/sign/submit/wait sequence.
      const server = new rpc.Server(rpcUrl);
      const account = await server.getAccount(from);
      await restoreAndRetry({
        restorePreamble: error.restorePreamble as {
          minResourceFee: string;
          transactionData: { build(): unknown };
        },
        sourceAccount: account,
        networkPassphrase,
        signer,
        server,
        contractId: vaultClient.contractId,
      });

      prepared = await vaultClient.deposit.prepare({ from, amount: 1_000_000_000n });
      const retrySigned = await prepared.sign(signer);
      const retrySubmitted = await retrySigned.submit(rpcUrl);
      const confirmed = await retrySubmitted.wait();
      console.log(`Deposit confirmed after restore in ledger ${confirmed.ledger}`);
    } else {
      throw error;
    }
  }

  const userShares = await vaultClient.getShares(from);
  console.log(`User now has ${userShares} shares`);
}

/**
 * Example: full withdrawal lifecycle (simulate -> sign -> submit -> poll -> confirm).
 */
async function withdrawExample() {
  const rpcUrl = "https://soroban-testnet.stellar.org";
  const networkPassphrase = "Test SDF Network ; September 2015";

  const vaultClient = new VaultClient({
    contractId: "CACTXW...(your vault contract ID)",
    networkPassphrase,
    rpcUrl,
  });

  const signer = ServerKeypairSigner.fromSecret("S...(your secret key)");
  const to = await signer.getPublicKey();

  const sharesToRedeem = await vaultClient.getShares(to);

  const prepared = await vaultClient.withdraw.prepare({
    to,
    shares: sharesToRedeem,
  });

  const signed = await prepared.sign(signer);
  const submitted = await signed.submit(rpcUrl);
  const confirmed = await submitted.wait();

  console.log(`Withdrawal confirmed in ledger ${confirmed.ledger}, returned ${confirmed.result} asset units`);
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
 * Example: read-only vault view calls
 */
async function readOnlyExample() {
  const vaultClient = new VaultClient({
    contractId: "CACTXW...(your vault contract ID)",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
  });

  const totalAssets = await vaultClient.totalAssets();
  const totalShares = await vaultClient.totalShares();
  console.log(`Vault holds ${totalAssets} asset units backing ${totalShares} shares`);
}

export { depositExample, withdrawExample, apiExample, readOnlyExample };
