import {
  Client as GeneratedVaultClient,
  YIELD_VAULT_SPEC_HASH,
} from "../generated/yield_vault";
import {
  PreparedTransaction,
  PreparedTransactionMeta,
  SubmittedTransaction,
  createOperationId,
  needsRestore,
} from "../lifecycle";
import {
  SpecMismatchError,
  SimulationDiagnosticsError,
  parseContractError,
  RestoreRequiredError,
  SdkEndpointError,
  toSimulationError,
} from "../errors";
import {
  buildSimulationFailureDiagnostics,
  extractContractErrorCode,
} from "../simulationDiagnostics";
import { rpc } from "@stellar/stellar-sdk";
import { toTokenUnits } from "../types";
import type { TokenAmount, VaultConfig } from "../types";
import { validateEndpointUrl, normalizeEndpointUrl } from "../endpoint";
import { buildSdkFailureDiagnostics } from "../diagnostics";

/**
 * Options that give one logical operation a stable identity across retries.
 *
 * Supply an `idempotencyKey` when a retry may rebuild and re-sign the
 * transaction (for example after a timeout): the same key and arguments
 * produce the same `operationId`, so submit() reuses the first transaction
 * hash instead of applying the effect twice. The key never goes on-chain.
 */
export interface OperationIdentityOptions {
  /** Stable caller-supplied key for safe retries of this operation. */
  idempotencyKey?: string;
  /** Explicit operation id; prefer `idempotencyKey` for normal retries. */
  operationId?: string;
}

export interface PreparedMethod<TArgs, TResult> {
  (args: TArgs): Promise<PreparedTransaction<TResult>>;
  prepare(args: TArgs): Promise<PreparedTransaction<TResult>>;
}

/**
 * Amount arguments accept a `bigint`, a base-unit decimal string, or a safe
 * integer `number`; anything that would lose precision throws
 * {@link InvalidAmountError} before a transaction is built.
 */
export interface DepositArgs extends OperationIdentityOptions {
  from: string;
  amount: TokenAmount;
  min_shares_out?: TokenAmount;
}

export interface SharesArgs extends OperationIdentityOptions {
  to: string;
  shares: TokenAmount;
}

export interface HarvestArgs extends OperationIdentityOptions {
  caller: string;
  min_amount_out?: TokenAmount;
}

export interface RebalanceArgs extends OperationIdentityOptions {
  caller: string;
  target: string;
  amount: TokenAmount;
}

interface PreparedRequest {
  args: Record<string, any>;
  identity?: OperationIdentityOptions;
}

export class VaultClient {
  public readonly generatedClient: GeneratedVaultClient;
  public readonly contractId: string;
  public readonly networkPassphrase: string;
  public readonly rpcUrl: string;
  public readonly specHash: string;
  public readonly configFingerprint?: string;

  constructor(config: VaultConfig) {
    const rpcValidation = validateEndpointUrl(config.rpcUrl);
    if (!rpcValidation.valid) {
      const diagnostics = buildSdkFailureDiagnostics("VALIDATION_FAILED", {
        stage: "endpoint-configuration",
        summary: `RPC endpoint configuration invalid: ${rpcValidation.error}`,
        remediation: "Provide a valid Soroban RPC endpoint URL; existing state was preserved.",
        retryable: false,
      });
      throw new SdkEndpointError(
        `Invalid RPC endpoint URL: ${rpcValidation.error}`,
        diagnostics,
        [rpcValidation.error ?? "Invalid rpcUrl"],
        "simulate",
        false
      );
    }

    this.contractId = config.contractId;
    this.networkPassphrase = config.networkPassphrase;
    this.rpcUrl = normalizeEndpointUrl(config.rpcUrl);
    this.specHash = config.specHash || YIELD_VAULT_SPEC_HASH;
    this.configFingerprint = config.configFingerprint;

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

  /**
   * Reconfigures the RPC endpoint URL safely.
   * If validation fails, throws SdkEndpointError and preserves existing configuration.
   */
  public configureEndpoint(rpcUrl: string): void {
    const rpcValidation = validateEndpointUrl(rpcUrl);
    if (!rpcValidation.valid) {
      const diagnostics = buildSdkFailureDiagnostics("VALIDATION_FAILED", {
        stage: "endpoint-configuration",
        summary: `RPC endpoint configuration invalid: ${rpcValidation.error}`,
        remediation: "Provide a valid Soroban RPC endpoint URL; existing state was preserved.",
        retryable: false,
      });
      throw new SdkEndpointError(
        `Invalid RPC endpoint URL: ${rpcValidation.error}`,
        diagnostics,
        [rpcValidation.error ?? "Invalid rpcUrl"],
        "simulate",
        false
      );
    }
    (this as any).rpcUrl = normalizeEndpointUrl(rpcUrl);
  }

  private initMethods() {
    const deposit = (args: DepositArgs) =>
      this.prepareStateChangingTx<bigint>("deposit", () => ({
        args: {
          from: args.from,
          amount: toTokenUnits(args.amount, { field: "amount" }),
          min_shares_out: toTokenUnits(args.min_shares_out ?? 0n, { field: "min_shares_out" }),
        },
        identity: { idempotencyKey: args.idempotencyKey, operationId: args.operationId },
      }));
    this.deposit = Object.assign(deposit, { prepare: deposit });

    const withdraw = (args: SharesArgs) =>
      this.prepareStateChangingTx<bigint>("withdraw", () => ({
        args: {
          to: args.to,
          shares: toTokenUnits(args.shares, { field: "shares" }),
        },
        identity: { idempotencyKey: args.idempotencyKey, operationId: args.operationId },
      }));
    this.withdraw = Object.assign(withdraw, { prepare: withdraw });

    const harvest = (args: HarvestArgs) =>
      this.prepareStateChangingTx<bigint>("harvest", () => ({
        args: {
          caller: args.caller,
          min_amount_out: toTokenUnits(args.min_amount_out ?? 0n, { field: "min_amount_out" }),
        },
        identity: { idempotencyKey: args.idempotencyKey, operationId: args.operationId },
      }));
    this.harvest = Object.assign(harvest, { prepare: harvest });

    const rebalance = (args: RebalanceArgs) =>
      this.prepareStateChangingTx<void>("rebalance", () => ({
        args: {
          caller: args.caller,
          target: args.target,
          amount: toTokenUnits(args.amount, { field: "amount" }),
        },
        identity: { idempotencyKey: args.idempotencyKey, operationId: args.operationId },
      }));
    this.rebalance = Object.assign(rebalance, { prepare: rebalance });

    const emergencyWithdraw = (args: SharesArgs) =>
      this.prepareStateChangingTx<bigint>("emergency_withdraw", () => ({
        args: {
          to: args.to,
          shares: toTokenUnits(args.shares, { field: "shares" }),
        },
        identity: { idempotencyKey: args.idempotencyKey, operationId: args.operationId },
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
    buildRequest: () => PreparedRequest
  ): Promise<PreparedTransaction<TResult>> {
    // Amount/argument validation runs before any RPC call. InvalidAmountError
    // keeps its class (callers already branch on it) but gains privacy-safe
    // diagnostics naming the validation stage; no transaction is built.
    let args: Record<string, any>;
    let identity: OperationIdentityOptions | undefined;
    try {
      const request = buildRequest();
      args = request.args;
      identity = request.identity;
    } catch (error) {
      throw toSimulationError(error, { method: methodName });
    }

    const argsHash = JSON.stringify(args, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    const operationId = createOperationId({
      contractId: this.contractId,
      networkPassphrase: this.networkPassphrase,
      method: methodName,
      argsHash,
      idempotencyKey: identity?.idempotencyKey,
      operationId: identity?.operationId,
    });

    try {
      const fn = (this.generatedClient as any)[methodName];
      if (typeof fn !== "function") {
        throw new SimulationDiagnosticsError(
          buildSimulationFailureDiagnostics("CONTEXT_INSUFFICIENT", {
            stage: "transaction-build",
          }),
          { method: methodName }
        );
      }

      const assembled = await fn.call(this.generatedClient, args);
      const simulation = assembled.simulation;

      // Defensive: a failed simulation can be returned instead of thrown by
      // the generated client. Surface it through the same diagnostic path so
      // the caller never receives a half-built PreparedTransaction.
      if (simulation && rpc.Api.isSimulationError(simulation)) {
        const eventCount = Array.isArray((simulation as any).diagnosticEvents)
          ? (simulation as any).diagnosticEvents.length
          : Array.isArray((simulation as any).events)
          ? (simulation as any).events.length
          : 0;
        throw toSimulationError(
          new Error(String((simulation as any).error ?? "simulation failed")),
          {
            method: methodName,
            context: { diagnosticEventCount: eventCount },
          }
        );
      }

      if (needsRestore(assembled.simulation)) {
        throw new RestoreRequiredError(
          assembled.simulation.restorePreamble.minResourceFee,
          assembled.simulation.restorePreamble
        );
      }

      let simulationResult: TResult;
      try {
        simulationResult = (assembled.result?.unwrap?.() ?? assembled.result) as TResult;
      } catch (decodeError) {
        // A contract rejection thrown by Result.unwrap carries a decodable
        // code; anything else means the pinned bindings could not decode the
        // returned value.
        const code = extractContractErrorCode(decodeError);
        if (code !== undefined) {
          throw toSimulationError(decodeError, {
            method: methodName,
            context: { contractErrorCode: code },
          });
        }
        throw new SimulationDiagnosticsError(
          buildSimulationFailureDiagnostics("RESULT_DECODE_FAILED", {
            stage: "result-decoding",
          }),
          { method: methodName }
        );
      }

      const rawXdr = assembled.built ? assembled.built.toXDR() : assembled.simulation;

      const meta: PreparedTransactionMeta<TResult> = {
        simulationResult,
        footprint: assembled.simulation?.footprint || "",
        authEntries: assembled.simulation?.auth || [],
        minResourceFee: assembled.simulation?.minResourceFee || "0",
        transactionData: assembled.simulation?.transactionData || "",
        latestLedger: assembled.simulation?.latestLedger || 0,
        validUntilLedger: (assembled.simulation?.latestLedger || 0) + 100,
        contractId: this.contractId,
        networkPassphrase: this.networkPassphrase,
        method: methodName,
        argsHash,
        operationId,
        ...(identity?.idempotencyKey
          ? { idempotencyKey: identity.idempotencyKey }
          : {}),
        specHash: this.specHash,
        configFingerprint: this.configFingerprint,
      };

      return new PreparedTransaction<TResult>(rawXdr, meta);
    } catch (error) {
      // Known typed errors keep their class and gain diagnostics; failures
      // without a decodable code or diagnostic events become a privacy-safe
      // SimulationDiagnosticsError instead of echoing raw upstream text.
      throw toSimulationError(error, { method: methodName });
    }
  }

  public getConfigFingerprint(): string | undefined {
    return this.configFingerprint;
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
