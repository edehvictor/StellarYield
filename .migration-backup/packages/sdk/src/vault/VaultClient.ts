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
import type { VaultConfig } from "../types";

export interface PreparedMethod<TArgs, TResult> {
  (args: TArgs): Promise<PreparedTransaction<TResult>>;
  prepare(args: TArgs): Promise<PreparedTransaction<TResult>>;
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
    this.deposit = Object.assign(
      (args: { from: string; amount: bigint; min_shares_out?: bigint }) =>
        this.prepareStateChangingTx<bigint>("deposit", {
          from: args.from,
          amount: args.amount,
          min_shares_out: args.min_shares_out ?? 0n,
        }),
      {
        prepare: (args: { from: string; amount: bigint; min_shares_out?: bigint }) =>
          this.prepareStateChangingTx<bigint>("deposit", {
            from: args.from,
            amount: args.amount,
            min_shares_out: args.min_shares_out ?? 0n,
          }),
      }
    );

    this.withdraw = Object.assign(
      (args: { to: string; shares: bigint }) =>
        this.prepareStateChangingTx<bigint>("withdraw", args),
      {
        prepare: (args: { to: string; shares: bigint }) =>
          this.prepareStateChangingTx<bigint>("withdraw", args),
      }
    );

    this.harvest = Object.assign(
      (args: { caller: string; min_amount_out?: bigint }) =>
        this.prepareStateChangingTx<bigint>("harvest", {
          caller: args.caller,
          min_amount_out: args.min_amount_out ?? 0n,
        }),
      {
        prepare: (args: { caller: string; min_amount_out?: bigint }) =>
          this.prepareStateChangingTx<bigint>("harvest", {
            caller: args.caller,
            min_amount_out: args.min_amount_out ?? 0n,
          }),
      }
    );

    this.rebalance = Object.assign(
      (args: { caller: string; target: string; amount: bigint }) =>
        this.prepareStateChangingTx<void>("rebalance", args),
      {
        prepare: (args: { caller: string; target: string; amount: bigint }) =>
          this.prepareStateChangingTx<void>("rebalance", args),
      }
    );

    this.emergencyWithdraw = Object.assign(
      (args: { to: string; shares: bigint }) =>
        this.prepareStateChangingTx<bigint>("emergency_withdraw", args),
      {
        prepare: (args: { to: string; shares: bigint }) =>
          this.prepareStateChangingTx<bigint>("emergency_withdraw", args),
      }
    );
  }

  // Callable method interfaces
  public deposit!: PreparedMethod<
    { from: string; amount: bigint; min_shares_out?: bigint },
    bigint
  >;

  public withdraw!: PreparedMethod<
    { to: string; shares: bigint },
    bigint
  >;

  public harvest!: PreparedMethod<
    { caller: string; min_amount_out?: bigint },
    bigint
  >;

  public rebalance!: PreparedMethod<
    { caller: string; target: string; amount: bigint },
    void
  >;

  public emergencyWithdraw!: PreparedMethod<
    { to: string; shares: bigint },
    bigint
  >;

  private async prepareStateChangingTx<TResult>(
    methodName: string,
    args: Record<string, any>
  ): Promise<PreparedTransaction<TResult>> {
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
        argsHash: JSON.stringify(args),
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

  async getFlashLoanFee(amount: bigint): Promise<bigint> {
    try {
      const tx = await this.generatedClient.get_flash_loan_fee({ amount: amount as any });
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
