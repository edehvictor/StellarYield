import {
  Contract,
  SorobanRpc,
  Address,
  nativeToScVal,
  scValToNative,
  XdrLargeInt,
} from "@stellar/stellar-sdk";
import type { VaultConfig, DepositParams, WithdrawParams, VaultInfo } from "../types";

/**
 * VaultClient provides a typed wrapper around the StellarYield Vault contract.
 * 
 * @remarks
 * This client handles all interactions with the YieldVault Soroban contract,
 * including deposits, withdrawals, and share management.
 * 
 * @example
 * ```typescript
 * import { VaultClient } from '@stellaryield/sdk';
 * 
 * const client = new VaultClient({
 *   contractId: 'CACT...",
 *   networkPassphrase: 'Test SDF Network ; September 2015',
 *   rpcUrl: 'https://soroban-testnet.stellar.org'
 * });
 * 
 * const shares = await client.deposit({
 *   from: 'GB...',
 *   amount: '1000000000',
 *   minSharesOut: '990000000'
 * });
 * ```
 */
export class VaultClient {
  private config: VaultConfig;
  private server: SorobanRpc.Server;

  constructor(config: VaultConfig) {
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
  }

  /**
   * Deposit tokens into the vault and receive vault shares.
   * 
   * @param params - Deposit parameters including from address, amount, and optional min shares
   * @returns Promise resolving to the number of shares minted
   * 
   * @throws If the deposit amount is zero or slippage protection is triggered
   * 
   * @remarks
   * The first depositor receives shares at a 1:1 ratio with assets.
   * Subsequent deposits receive shares proportional to the current share price.
   * Use `minSharesOut` to protect against slippage during the deposit.
   */
  async deposit(params: DepositParams): Promise<string> {
    const contract = new Contract(this.config.contractId);
    const fromAddress = Address.fromString(params.from);
    const amount = new XdrLargeInt("i128", params.amount);
    const minSharesOut = new XdrLargeInt("i128", params.minSharesOut ?? "0");

    const result = await this.server.simulateTransaction(
      contract.call(
        "deposit",
        fromAddress.toScVal(),
        amount.toScVal(),
        minSharesOut.toScVal()
      )
    );

    const shares = scValToNative(result.result!.retval) as bigint;
    return shares.toString();
  }

  /**
   * Withdraw tokens from the vault by burning vault shares.
   * 
   * @param params - Withdraw parameters including to address and number of shares
   * @returns Promise resolving to the amount of tokens withdrawn
   * 
   * @throws If the user has insufficient shares
   */
  async withdraw(params: WithdrawParams): Promise<string> {
    const contract = new Contract(this.config.contractId);
    const toAddress = Address.fromString(params.to);
    const shares = new XdrLargeInt("i128", params.shares);

    const result = await this.server.simulateTransaction(
      contract.call(
        "withdraw",
        toAddress.toScVal(),
        shares.toScVal()
      )
    );

    const amount = scValToNative(result.result!.retval) as bigint;
    return amount.toString();
  }

  /**
   * Get the number of vault shares held by a user.
   * 
   * @param user - The user's wallet address
   * @returns The number of shares owned by the user
   */
  async getShares(user: string): Promise<string> {
    const contract = new Contract(this.config.contractId);
    const userAddress = Address.fromString(user);

    const result = await this.server.simulateTransaction(
      contract.call("get_shares", userAddress.toScVal())
    );

    const shares = scValToNative(result.result!.retval) as bigint;
    return shares.toString();
  }

  /**
   * Get total vault shares in circulation.
   * 
   * @returns Total number of shares
   */
  async totalShares(): Promise<string> {
    const contract = new Contract(this.config.contractId);

    const result = await this.server.simulateTransaction(
      contract.call("total_shares")
    );

    const total = scValToNative(result.result!.retval) as bigint;
    return total.toString();
  }

  /**
   * Get total assets held by the vault.
   * 
   * @returns Total assets in the vault's base token
   */
  async totalAssets(): Promise<string> {
    const contract = new Contract(this.config.contractId);

    const result = await this.server.simulateTransaction(
      contract.call("total_assets")
    );

    const total = scValToNative(result.result!.retval) as bigint;
    return total.toString();
  }

  /**
   * Get comprehensive vault information.
   * 
   * @returns Object containing total shares, total assets, token, and admin addresses
   */
  async getInfo(): Promise<VaultInfo> {
    const contract = new Contract(this.config.contractId);

    const [sharesResult, assetsResult, tokenResult, adminResult] = await Promise.all([
      this.server.simulateTransaction(contract.call("total_shares")),
      this.server.simulateTransaction(contract.call("total_assets")),
      this.server.simulateTransaction(contract.call("get_token")),
      this.server.simulateTransaction(contract.call("get_admin")),
    ]);

    return {
      totalShares: scValToNative(sharesResult.result!.retval).toString(),
      totalAssets: scValToNative(assetsResult.result!.retval).toString(),
      token: scValToNative(tokenResult.result!.retval),
      admin: scValToNative(adminResult.result!.retval),
    };
  }

  /**
   * Convert an asset amount to the equivalent number of shares.
   * 
   * @param assets - Amount of assets to convert
   * @returns Equivalent number of shares at current price
   */
  async convertToShares(assets: string): Promise<string> {
    const contract = new Contract(this.config.contractId);
    const assetsVal = new XdrLargeInt("i128", assets);

    const result = await this.server.simulateTransaction(
      contract.call("convert_to_shares", assetsVal.toScVal())
    );

    return scValToNative(result.result!.retval).toString();
  }

  /**
   * Convert a number of shares to the equivalent asset amount.
   * 
   * @param shares - Number of shares to convert
   * @returns Equivalent amount of assets at current price
   */
  async convertToAssets(shares: string): Promise<string> {
    const contract = new Contract(this.config.contractId);
    const sharesVal = new XdrLargeInt("i128", shares);

    const result = await this.server.simulateTransaction(
      contract.call("convert_to_assets", sharesVal.toScVal())
    );

    return scValToNative(result.result!.retval).toString();
  }

  /**
   * Preview how many shares would be minted for a given deposit amount.
   * 
   * @param assets - Amount of assets to preview deposit
   * @returns Number of shares that would be minted
   */
  async previewDeposit(assets: string): Promise<string> {
    const contract = new Contract(this.config.contractId);
    const assetsVal = new XdrLargeInt("i128", assets);

    const result = await this.server.simulateTransaction(
      contract.call("preview_deposit", assetsVal.toScVal())
    );

    return scValToNative(result.result!.retval).toString();
  }
}
