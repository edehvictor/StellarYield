/**
 * RebalanceExecutorService
 *
 * Replaces simulated rebalance execution with a real relayer-backed pipeline:
 *  1. Dry-run: validate allocations and estimate expected fill amounts.
 *  2. Submit: build a Stellar transaction, obtain a fee-bump signature from the
 *     relayer, and submit to the network.
 *  3. Confirm: poll for the transaction result and classify success / failure.
 *  4. Idempotency: track in-flight execution locks so duplicate worker activity
 *     never causes duplicate submissions.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { RebalanceExecutionResult } from './rebalanceQueueService';
import { RebalanceQueueEntryDTO } from './rebalanceQueueService';

// ── Execution failure classes ──────────────────────────────────────────────

export const FAILURE_CLASS = {
  /** Network issue — safe to retry */
  TRANSIENT: 'TRANSIENT',
  /** Bad fee or sequence — retry after refresh */
  FEE_SEQUENCE: 'FEE_SEQUENCE',
  /** Allocation constraint / slippage breach — do NOT retry blindly */
  CONSTRAINT: 'CONSTRAINT',
  /** Expired intent or stale nonce */
  STALE_INTENT: 'STALE_INTENT',
  /** Unrecoverable (e.g. malformed XDR) */
  PERMANENT: 'PERMANENT',
} as const;

export type FailureClass = (typeof FAILURE_CLASS)[keyof typeof FAILURE_CLASS];

export interface ExecutionAttempt {
  entryId: string;
  attemptNumber: number;
  startedAt: Date;
  completedAt?: Date;
  transactionHash?: string;
  feeBumpHash?: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  failureClass?: FailureClass;
  failureReason?: string;
}

export interface DryRunResult {
  viable: boolean;
  estimatedFill: number;
  reason?: string;
}

// ── In-process idempotency lock ────────────────────────────────────────────

const inFlightLocks = new Set<string>();

export function isLocked(entryId: string): boolean {
  return inFlightLocks.has(entryId);
}

function lock(entryId: string): void {
  inFlightLocks.add(entryId);
}

function unlock(entryId: string): void {
  inFlightLocks.delete(entryId);
}

// ── Configuration ──────────────────────────────────────────────────────────

export interface ExecutorConfig {
  relayerUrl: string;
  networkPassphrase: string;
  rpcUrl: string;
  /** Seconds to wait for transaction confirmation */
  confirmationTimeoutSecs: number;
  /** Max retries on transient network errors */
  networkRetries: number;
}

const DEFAULT_CONFIG: ExecutorConfig = {
  relayerUrl: process.env.RELAYER_URL ?? 'http://localhost:3001',
  networkPassphrase: process.env.NETWORK_PASSPHRASE ?? StellarSdk.Networks.TESTNET,
  rpcUrl: process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  confirmationTimeoutSecs: 30,
  networkRetries: 2,
};

// ── RebalanceExecutorService ────────────────────────────────────────────────

export class RebalanceExecutorService {
  private config: ExecutorConfig;
  private server: StellarSdk.SorobanRpc.Server;

  constructor(config: Partial<ExecutorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.server = new StellarSdk.SorobanRpc.Server(this.config.rpcUrl);
  }

  /**
   * Validate that a rebalance can execute given current on-chain state.
   * Returns estimated fill percentage without submitting anything.
   */
  async dryRun(entry: RebalanceQueueEntryDTO): Promise<DryRunResult> {
    // Validate allocation weights sum to 100
    const totalWeight = Object.values(entry.targetAllocations).reduce(
      (sum, w) => sum + w,
      0,
    );
    if (Math.abs(totalWeight - 100) > 0.01 && Math.abs(totalWeight - 1) > 0.001) {
      return {
        viable: false,
        estimatedFill: 0,
        reason: `Allocation weights sum to ${totalWeight}, expected 100 (or 1.0)`,
      };
    }

    // Validate we have something to rebalance
    const driftAssets = Object.keys(entry.targetAllocations).filter((asset) => {
      const target = entry.targetAllocations[asset] ?? 0;
      const current = entry.currentAllocations[asset] ?? 0;
      return Math.abs(target - current) > 0.001;
    });

    if (driftAssets.length === 0) {
      return {
        viable: false,
        estimatedFill: 100,
        reason: 'No allocation drift — rebalance not required',
      };
    }

    // Check intent expiry via executionStrategy metadata
    const strategy = entry.executionStrategy as Record<string, unknown>;
    if (strategy.intentValidUntil) {
      const expiry = new Date(strategy.intentValidUntil as string).getTime();
      if (Date.now() > expiry) {
        return {
          viable: false,
          estimatedFill: 0,
          reason: 'Intent expired before execution',
        };
      }
    }

    // Estimate fill — for now assume full fill is possible; a real implementation
    // would query on-chain liquidity via the Soroban RPC simulate endpoint.
    return { viable: true, estimatedFill: 100 };
  }

  /**
   * Execute a rebalance queue entry through the relayer pipeline.
   *
   * Steps:
   *   1. Acquire idempotency lock.
   *   2. Dry-run validation.
   *   3. Build Soroban transaction XDR.
   *   4. POST to relayer for fee-bump signature.
   *   5. Submit fee-bumped transaction to Stellar RPC.
   *   6. Confirm (poll) for transaction result.
   *   7. Return execution result with real transaction hash.
   */
  async execute(
    entry: RebalanceQueueEntryDTO,
    attempt: ExecutionAttempt,
  ): Promise<RebalanceExecutionResult> {
    if (isLocked(entry.id)) {
      throw new Error(
        `Entry ${entry.id} is already being processed — duplicate worker activity detected`,
      );
    }

    lock(entry.id);

    try {
      // ── 1. Dry-run ───────────────────────────────────────────────────────
      const dry = await this.dryRun(entry);
      if (!dry.viable) {
        attempt.failureClass = dry.reason?.includes('expired')
          ? FAILURE_CLASS.STALE_INTENT
          : FAILURE_CLASS.CONSTRAINT;
        attempt.failureReason = dry.reason;
        throw new Error(`Dry-run failed: ${dry.reason}`);
      }

      // ── 2. Build inner transaction XDR ───────────────────────────────────
      const innerXdr = await this.buildRebalanceTransactionXdr(entry);

      // ── 3. Obtain fee-bump from relayer ──────────────────────────────────
      const feeBumpXdr = await this.signWithRelayer(innerXdr);

      // ── 4. Submit to Stellar RPC ─────────────────────────────────────────
      const submitResult = await this.submitTransaction(feeBumpXdr);
      attempt.transactionHash = submitResult.innerHash;
      attempt.feeBumpHash = submitResult.feeBumpHash;
      attempt.status = 'submitted';

      // ── 5. Confirm transaction ───────────────────────────────────────────
      const confirmed = await this.confirmTransaction(submitResult.feeBumpHash);

      attempt.status = confirmed ? 'confirmed' : 'failed';
      if (!confirmed) {
        attempt.failureClass = FAILURE_CLASS.TRANSIENT;
        attempt.failureReason = 'Transaction not confirmed within timeout';
      }

      return {
        queueEntryId: entry.id,
        totalExecuted: dry.estimatedFill,
        expectedAmount: 100,
        filledPercentage: dry.estimatedFill,
        transactionHash: submitResult.innerHash,
        executionDetails: {
          status: confirmed ? 'confirmed' : 'unconfirmed',
          feeBumpHash: submitResult.feeBumpHash,
          allocationsAdjusted: entry.targetAllocations,
          failureClass: attempt.failureClass,
          timestamp: new Date(),
        },
      };
    } finally {
      unlock(entry.id);
      attempt.completedAt = new Date();
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async buildRebalanceTransactionXdr(
    entry: RebalanceQueueEntryDTO,
  ): Promise<string> {
    // Derive the vault contract address from the execution strategy metadata.
    const strategy = entry.executionStrategy as Record<string, unknown>;
    const vaultContractId =
      (strategy.vaultContractId as string | undefined) ??
      process.env.VAULT_CONTRACT_ID;

    if (!vaultContractId) {
      throw new Error('No vault contract ID available for transaction construction');
    }

    // Load the relayer account to get a valid sequence number.
    const relayerPublicKey = process.env.RELAYER_PUBLIC_KEY;
    if (!relayerPublicKey) {
      throw new Error('RELAYER_PUBLIC_KEY not configured');
    }

    const account = await this.server.getAccount(relayerPublicKey);

    // Build a Soroban invoke-contract operation for the vault's rebalance function.
    const contract = new StellarSdk.Contract(vaultContractId);
    const allocArgs = StellarSdk.nativeToScVal(entry.targetAllocations, { type: 'map' });

    const operation = contract.call('rebalance', allocArgs);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(120)
      .build();

    // Simulate first to get correct resource fees
    const simResult = await this.server.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const preparedTx = StellarSdk.SorobanRpc.assembleTransaction(tx, simResult).build();
    return preparedTx.toXDR();
  }

  private async signWithRelayer(innerXdr: string): Promise<string> {
    const response = await fetch(`${this.config.relayerUrl}/api/relayer/fee-bump`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ innerTxXdr: innerXdr }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const errMsg = (body.error as string | undefined) ?? response.statusText;
      throw new Error(`Relayer error ${response.status}: ${errMsg}`);
    }

    const data = (await response.json()) as { feeBumpXdr: string };
    return data.feeBumpXdr;
  }

  private async submitTransaction(
    feeBumpXdr: string,
  ): Promise<{ innerHash: string; feeBumpHash: string }> {
    const tx = StellarSdk.TransactionBuilder.fromXDR(
      feeBumpXdr,
      this.config.networkPassphrase,
    );
    const result = await this.server.sendTransaction(tx);

    if (result.status === 'ERROR') {
      throw new Error(`Transaction submission failed: ${JSON.stringify(result.errorResult)}`);
    }

    const feeBumpHash = result.hash;
    // The inner transaction hash is the fee-bump's inner tx
    const innerHash =
      tx instanceof StellarSdk.FeeBumpTransaction
        ? tx.innerTransaction.hash().toString('hex')
        : feeBumpHash;

    return { innerHash, feeBumpHash };
  }

  private async confirmTransaction(txHash: string): Promise<boolean> {
    const deadlineMs = Date.now() + this.config.confirmationTimeoutSecs * 1000;

    while (Date.now() < deadlineMs) {
      const result = await this.server.getTransaction(txHash);
      if (result.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return true;
      }
      if (result.status === StellarSdk.SorobanRpc.Api.GetTransactionStatus.FAILED) {
        return false;
      }
      // NOT_FOUND or still pending — wait and retry
      await new Promise((r) => setTimeout(r, 2000));
    }

    return false;
  }

  /**
   * Classify a caught error into a FailureClass for downstream retry logic.
   */
  classifyError(error: Error): FailureClass {
    const msg = error.message.toLowerCase();
    if (msg.includes('expired') || msg.includes('stale')) return FAILURE_CLASS.STALE_INTENT;
    if (msg.includes('constraint') || msg.includes('slippage') || msg.includes('dry-run')) {
      return FAILURE_CLASS.CONSTRAINT;
    }
    if (msg.includes('sequence') || msg.includes('fee')) return FAILURE_CLASS.FEE_SEQUENCE;
    if (msg.includes('malformed') || msg.includes('invalid xdr')) return FAILURE_CLASS.PERMANENT;
    return FAILURE_CLASS.TRANSIENT;
  }
}

export const rebalanceExecutorService = new RebalanceExecutorService();
