import {
  Client as GeneratedVaultClient,
  YIELD_VAULT_SPEC_HASH,
} from "../generated/yield_vault";
import {
  PreparedTransaction,
  PreparedTransactionMeta,
  SubmittedTransaction,
  needsRestore,
} from "../lifecycle";
import { SpecMismatchError, parseContractError, RestoreRequiredError } from "../errors";
import { toTokenUnits } from "../types";
import type { TokenAmount, VaultConfig } from "../types";

export interface PreparedMethod<TArgs, TResult> {
  (args: TArgs): Promise<PreparedTransaction<TResult>>;
  prepare(args: TArgs): Promise<PreparedTransaction<TResult>>;
}

/**
 * Amount arguments accept a `bigint`, a base-unit decimal string, or a safe
 * integer `number`; anything that would lose precision throws
 * {@link InvalidAmountError} before a transaction is built.
 */
export interface DepositArgs {
  from: string;
  amount: TokenAmount;
  min_shares_out?: TokenAmount;
}

export interface SharesArgs {
  to: string;
  shares: TokenAmount;
}

export interface HarvestArgs {
  caller: string;
  min_amount_out?: TokenAmount;
}

export interface RebalanceArgs {
  caller: string;
  target: string;
  amount: TokenAmount;
}

export class VaultClient {
  public readonly generatedClient: GeneratedVaultClient;
  public readonly contractId: string;
  public readonly networkPassphrase: string;
  public readonly rpcUrl: string;
  public readonly specHash: string;

  constructor(config: VaultConfig) {
    this.contractId = config.contractId;
    this.networkPassphrase = config.networkPassphrase;
    this.rpcUrl = config.rpcUrl;
    this.specHash = config.specHash || YIELD_VAULT_SPEC_HASH;

    if (config.specHash && config.specHash !== YIELD_VAULT_SPEC_HASH) {
      throw new SpecMismatchError(YIELD_VAULT_SPEC_HASH, config.specHash);
    }

    this.generatedClient = new GeneratedVaultClient({
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
    });

    this.initMethods();
  }

  private initMethods() {
    const deposit = (args: DepositArgs) =>
      this.prepareStateChangingTx<bigint>("deposit", () => ({
        from: args.from,
        amount: toTokenUnits(args.amount, { field: "amount" }),
        min_shares_out: toTokenUnits(args.min_shares_out ?? 0n, { field: "min_shares_out" }),
      }));
    this.deposit = Object.assign(deposit, { prepare: deposit });

    const withdraw = (args: SharesArgs) =>
      this.prepareStateChangingTx<bigint>("withdraw", () => ({
        to: args.to,
        shares: toTokenUnits(args.shares, { field: "shares" }),
      }));
    this.withdraw = Object.assign(withdraw, { prepare: withdraw });

    const harvest = (args: HarvestArgs) =>
      this.prepareStateChangingTx<bigint>("harvest", () => ({
        caller: args.caller,
        min_amount_out: toTokenUnits(args.min_amount_out ?? 0n, { field: "min_amount_out" }),
      }));
    this.harvest = Object.assign(harvest, { prepare: harvest });

    const rebalance = (args: RebalanceArgs) =>
      this.prepareStateChangingTx<void>("rebalance", () => ({
        caller: args.caller,
        target: args.target,
        amount: toTokenUnits(args.amount, { field: "amount" }),
      }));
    this.rebalance = Object.assign(rebalance, { prepare: rebalance });

    const emergencyWithdraw = (args: SharesArgs) =>
      this.prepareStateChangingTx<bigint>("emergency_withdraw", () => ({
        to: args.to,
        shares: toTokenUnits(args.shares, { field: "shares" }),
      }));
    this.emergencyWithdraw = Object.assign(emergencyWithdraw, { prepare: emergencyWithdraw });
  }

  // Callable method interfaces
  public deposit!: PreparedMethod<DepositArgs, bigint>;

  public withdraw!: PreparedMethod<SharesArgs, bigint>;

  public harvest!: PreparedMethod<HarvestArgs, bigint>;

  public rebalance!: PreparedMethod<RebalanceArgs, void>;

  public emergencyWithdraw!: PreparedMethod<SharesArgs, bigint>;

  private async prepareStateChangingTx<TResult>(
    methodName: string,
    buildArgs: () => Record<string, any>
  ): Promise<PreparedTransaction<TResult>> {
    // Amount validation runs outside the try block so InvalidAmountError
    // reaches the caller as-is instead of being re-parsed as a contract error.
    const args = buildArgs();
    try {
      const fn = (this.generatedClient as any)[methodName];
      if (typeof fn !== "function") {
        throw new Error(`Unknown contract method '${methodName}'`);
      }

      const assembled = await fn.call(this.generatedClient, args);

      if (needsRestore(assembled.simulation)) {
        throw new RestoreRequiredError(
          assembled.simulation.restorePreamble.minResourceFee,
          assembled.simulation.restorePreamble
        );
      }

      const rawXdr = assembled.built ? assembled.built.toXDR() : assembled.simulation;

      const meta: PreparedTransactionMeta<TResult> = {
        simulationResult: (assembled.result?.unwrap?.() ?? assembled.result) as TResult,
        footprint: assembled.simulation?.footprint || "",
        authEntries: assembled.simulation?.auth || [],
        minResourceFee: assembled.simulation?.minResourceFee || "0",
        transactionData: assembled.simulation?.transactionData || "",
        latestLedger: assembled.simulation?.latestLedger || 0,
        validUntilLedger: (assembled.simulation?.latestLedger || 0) + 100,
        contractId: this.contractId,
        networkPassphrase: this.networkPassphrase,
        method: methodName,
        argsHash: JSON.stringify(args, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value
        ),
        specHash: this.specHash,
      };

      return new PreparedTransaction<TResult>(rawXdr, meta);
    } catch (error) {
      throw parseContractError(error, undefined, undefined, "simulate");
    }
  }

  // Read-only view methods
  async totalAssets(): Promise<bigint> {
    try {
      const tx = await this.generatedClient.total_assets();
      return BigInt((tx.result as any) || 0n);
    } catch (e) {
      throw parseContractError(e);
    }
  }

  async totalShares(): Promise<bigint> {
    try {
      const tx = await this.generatedClient.total_shares();
      return BigInt((tx.result as any) || 0n);
    } catch (e) {
      throw parseContractError(e);
    }
  }

  async getShares(user: string): Promise<bigint> {
    try {
      const tx = await this.generatedClient.get_shares({ user });
      return BigInt((tx.result as any) || 0n);
    } catch (e) {
      throw parseContractError(e);
    }
  }

  async getAdmin(): Promise<string> {
    try {
      const tx = await this.generatedClient.get_admin();
      return (tx.result as any)?.unwrap?.() || String(tx.result || "");
    } catch (e) {
      throw parseContractError(e);
    }
  }

  async getToken(): Promise<string> {
    try {
      const tx = await this.generatedClient.get_token();
      return (tx.result as any)?.unwrap?.() || String(tx.result || "");
    } catch (e) {
      throw parseContractError(e);
    }
  }

  async getFlashLoanFee(amount: TokenAmount): Promise<bigint> {
    const units = toTokenUnits(amount);
    try {
      const tx = await this.generatedClient.get_flash_loan_fee({ amount: units as any });
      return BigInt((tx.result as any) || 0n);
    } catch (e) {
      throw parseContractError(e);
    }
  }

  // Recovery helper
  public recoverTransaction<T = unknown>(hash: string): SubmittedTransaction<T> {
    return SubmittedTransaction.fromHash<T>(hash, {
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
    });
  }
}
