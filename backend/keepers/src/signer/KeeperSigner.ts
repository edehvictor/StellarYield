import {
  rpc,
  Keypair,
  TransactionBuilder,
  Networks,
  xdr,
  Contract,
  Address,
} from '@stellar/stellar-sdk';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * KeeperSigner manages the keeper bot's signing keypair and handles the
 * complete Soroban transaction lifecycle:
 *   1. Build a TransactionBuilder with the current sequence number
 *   2. Simulate the transaction to get resource fees
 *   3. Sign the transaction with the keeper's secret key
 *   4. Submit and poll for confirmation
 *
 * Security note: In production, replace `Keypair.fromSecret()` with a KMS
 * adapter that never exposes the raw private key in-process.
 */
export class KeeperSigner {
  private readonly keypair: Keypair;
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;

  constructor(secretKey?: string) {
    const key = secretKey ?? config.stellar.keeperSecretKey;
    if (!key) {
      throw new Error(
        'KEEPER_SECRET_KEY is not set. Provide a valid Stellar secret key.',
      );
    }
    this.keypair = Keypair.fromSecret(key);
    this.server = new rpc.Server(config.stellar.sorobanRpcUrl, {
      allowHttp: true,
    });
    this.networkPassphrase =
      config.stellar.network === 'mainnet'
        ? Networks.PUBLIC
        : Networks.TESTNET;
  }

  /** Public key of the keeper bot account */
  get publicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Invoke a Soroban contract function, simulating first to get resource
   * costs, then signing and submitting the transaction.
   *
   * @param contractId - The Soroban contract C-address
   * @param method     - The contract function name to invoke
   * @param args       - xdr.ScVal arguments to pass
   * @returns The transaction hash on success
   * @throws  On simulation error, auth failure, or submission failure
   */
  async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<string> {
    const account = await this.server.getAccount(this.keypair.publicKey());

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
    preparedTx.sign(this.keypair);

    const sendResult = await this.server.sendTransaction(preparedTx);
    if (sendResult.status === 'ERROR') {
      throw new Error(`sendTransaction failed: ${sendResult.errorResult?.toXDR('base64')}`);
    }

    const hash = sendResult.hash;
    logger.info({ hash, method, contractId }, 'Transaction submitted');

    // Poll for confirmation
    await this.pollForConfirmation(hash);
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
