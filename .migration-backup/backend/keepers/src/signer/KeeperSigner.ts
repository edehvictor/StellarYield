import {
  rpc,
  Networks,
  xdr,
  Contract,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  LocalSignerProvider,
  UnauthorizedOperationError,
  type SignerProvider,
} from './SignerProvider';
import { createKeeperAuditLog } from '../audit/KeeperAuditLog';

export type { SignerProvider } from './SignerProvider';
export { UnauthorizedOperationError } from './SignerProvider';

export interface KeeperAuditContext {
  workerName: string;
  jobId?: string;
  policyVersion?: string;
}

export interface KeeperSignerOptions {
  /** Opt-in tamper-evident audit logging (see issue #912). No-op when omitted. */
  auditLog?: ReturnType<typeof createKeeperAuditLog>;
}

function safeArgsSummary(args: xdr.ScVal[]): string[] {
  return args.map((arg) => {
    try {
      return arg.toXDR('base64');
    } catch {
      return String(arg);
    }
  });
}

/**
 * KeeperSigner manages the keeper bot's signing authority and handles the
 * complete Soroban transaction lifecycle:
 *   1. Build a TransactionBuilder with the current sequence number
 *   2. Simulate the transaction to get resource fees
 *   3. Sign the transaction via the active SignerProvider
 *   4. Submit and poll for confirmation
 *
 * Signing itself is delegated to a `SignerProvider` (local secret, env
 * secret, or an external/KMS-backed callback — see `./SignerProvider.ts`),
 * which also declares which contract methods it is allowed to authorize.
 * `invokeContract` rejects any other method before building a transaction.
 */
export class KeeperSigner {
  private readonly provider: SignerProvider;
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly auditLog?: ReturnType<typeof createKeeperAuditLog>;

  constructor(secretKeyOrProvider?: string | SignerProvider, options?: KeeperSignerOptions) {
    if (secretKeyOrProvider && typeof secretKeyOrProvider === 'object') {
      this.provider = secretKeyOrProvider;
    } else {
      const key = secretKeyOrProvider ?? config.stellar.keeperSecretKey;
      if (!key) {
        throw new Error(
          'KEEPER_SECRET_KEY is not set. Provide a valid Stellar secret key.',
        );
      }
      this.provider = new LocalSignerProvider(key);
    }

    this.auditLog = options?.auditLog;
    this.server = new rpc.Server(config.stellar.sorobanRpcUrl, {
      allowHttp: true,
    });
    this.networkPassphrase =
      config.stellar.network === 'mainnet'
        ? Networks.PUBLIC
        : Networks.TESTNET;
  }

  /** Public key of the currently active signer */
  get publicKey(): string {
    return this.provider.publicKey;
  }

  private recordDecision(
    auditContext: KeeperAuditContext | undefined,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    extra: { simulationResult?: unknown; txOutcome?: { status: 'success' | 'failure'; hash?: string; error?: string } },
  ): void {
    if (!this.auditLog || !auditContext) return;
    this.auditLog.appendDecision(auditContext.workerName, {
      workerName: auditContext.workerName,
      jobId: auditContext.jobId,
      policyVersion: auditContext.policyVersion ?? 'unversioned',
      contractId,
      method,
      inputs: { contractId, method, args: safeArgsSummary(args) },
      decision: `invoke ${method} on ${contractId}`,
      ...extra,
    });
  }

  /**
   * Invoke a Soroban contract function, simulating first to get resource
   * costs, then signing and submitting the transaction.
   *
   * @param contractId - The Soroban contract C-address
   * @param method     - The contract function name to invoke
   * @param args       - xdr.ScVal arguments to pass
   * @param auditContext - Optional worker/job metadata for the tamper-evident
   *                       audit trail (see issue #912); no-op if `auditLog`
   *                       wasn't supplied to this instance.
   * @returns The transaction hash on success
   * @throws  On unauthorized operation, simulation error, auth failure, or submission failure
   */
  async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
    options?: { requiredSequence?: number; fencingToken?: number; persistRecord?: (record: import('../queues/types').JobAttemptRecord) => Promise<void> },
    auditContext?: KeeperAuditContext,
  ): Promise<string> {
    if (!this.provider.allowedOperations.has(method)) {
      throw new UnauthorizedOperationError(method, this.provider.id);
    }

    logger.info(
      { providerId: this.provider.id, publicKey: this.provider.publicKey, method, contractId },
      '[KeeperSigner] Signer selected for job',
    );

    const account = await this.server.getAccount(this.provider.publicKey);

    if (options?.requiredSequence !== undefined) {
      const currentSequence = Number((account as any).sequence);
      if (currentSequence !== options.requiredSequence) {
        throw new Error(
          `SEQUENCE_MISMATCH: expected sequence ${options.requiredSequence}, got ${currentSequence}`,
        );
      }
    }

    const contract = new Contract(contractId);
    const op = contract.call(method, ...args);

    const tx = new TransactionBuilder(account, {
      fee: String(config.stellar.baseFee),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    // Simulate to get resource fees and auth entries
    const sim = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(sim)) {
      logger.error(
        { error: sim, contractId, method },
        '[KeeperSigner] Simulation failed with specific RPC error',
      );
      throw new Error(`Simulation failed: ${(sim as any).error}`);
    }

    if (!rpc.Api.isSimulationSuccess(sim)) {
      logger.error(
        { simResponse: (sim as any).toXDR?.() || sim, contractId, method },
        '[KeeperSigner] Unexpected simulation response status',
      );
      throw new Error('Unexpected simulation response');
    }

    // Prepare (inflate) with resource fees from simulation
    const preparedTx = rpc.assembleTransaction(tx, sim).build();
    const signedTx = await this.provider.sign(preparedTx, this.networkPassphrase);

    this.recordDecision(auditContext, contractId, method, args, {
      simulationResult: { minResourceFee: (sim as any).minResourceFee ?? null },
    });

    const sendResult = await this.server.sendTransaction(signedTx);
    if (sendResult.status === 'ERROR') {
      const errorMessage = `sendTransaction failed: ${sendResult.errorResult?.toXDR('base64')}`;
      this.recordDecision(auditContext, contractId, method, args, {
        txOutcome: { status: 'failure', error: errorMessage },
      });
      throw new Error(errorMessage);
    }

    const hash = sendResult.hash;
    logger.info({ hash, method, contractId }, 'Transaction submitted');

    if (options?.persistRecord && options.fencingToken !== undefined) {
      await options.persistRecord({
        jobId: hash,
        queueName: 'compound',
        state: 'submitted',
        attemptNumber: 0,
        fencingToken: options.fencingToken,
        requiredSequence: options.requiredSequence ?? 0,
        txHash: hash,
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        targetId: contractId,
      });
    }

    try {
      await this.pollForConfirmation(hash);
    } catch (err) {
      this.recordDecision(auditContext, contractId, method, args, {
        txOutcome: { status: 'failure', hash, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }

    this.recordDecision(auditContext, contractId, method, args, {
      txOutcome: { status: 'success', hash },
    });

    return hash;
  }

  /**
   * Poll the RPC until transaction is confirmed or fails.
   * Uses exponential back-off starting at 1s.
   */
  private async pollForConfirmation(hash: string): Promise<void> {
    let delay = 1000;
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(delay);
      const response = await this.server.getTransaction(hash);

      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        logger.info({ hash, attempt }, 'Transaction confirmed');
        return;
      }
      if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction ${hash} failed on-chain`);
      }
      delay = Math.min(delay * 1.5, 10_000);
    }
    throw new Error(`Transaction ${hash} did not confirm within timeout`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
