import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

/** Default operation allowlist for keeper-controlled hot keys. */
export const DEFAULT_ALLOWED_OPERATIONS = ['harvest', 'liquidate', 'rebalance'] as const;

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export class UnauthorizedOperationError extends Error {
  constructor(
    public readonly method: string,
    public readonly providerId: string,
  ) {
    super(`Signer "${providerId}" is not authorized to perform operation "${method}"`);
    this.name = 'UnauthorizedOperationError';
  }
}

/**
 * Least-privilege abstraction over "something that can sign a Soroban
 * transaction". `id` and `publicKey` are safe, non-secret identifiers used
 * for audit logging — implementations must never expose key material through
 * any other member.
 */
export interface SignerProvider {
  /** Non-secret label identifying this provider instance (safe to log). */
  readonly id: string;
  readonly publicKey: string;
  /** Contract method names this signer is allowed to authorize. */
  readonly allowedOperations: ReadonlySet<string>;
  /** Signs (and may mutate) `tx` in place, returning the signed transaction. */
  sign(tx: Transaction, networkPassphrase: string): Promise<Transaction>;
}

/**
 * Signs with a `Keypair` constructed directly from a secret string.
 * Equivalent to the keeper's original (pre-#911) hardcoded behavior.
 */
export class LocalSignerProvider implements SignerProvider {
  readonly id: string;
  readonly publicKey: string;
  readonly allowedOperations: ReadonlySet<string>;
  private readonly keypair: Keypair;

  constructor(
    secretKey: string,
    allowedOperations: readonly string[] = DEFAULT_ALLOWED_OPERATIONS,
    idPrefix = 'local',
  ) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.publicKey = this.keypair.publicKey();
    this.id = `${idPrefix}:${this.publicKey}`;
    this.allowedOperations = new Set(allowedOperations);
  }

  async sign(tx: Transaction, _networkPassphrase: string): Promise<Transaction> {
    tx.sign(this.keypair);
    return tx;
  }
}

/**
 * Same signing behavior as `LocalSignerProvider`, but sources its secret from
 * a named environment variable rather than a caller-supplied string — the
 * "environment" backend called for in issue #911's scope. Kept as a thin
 * subclass (not a separate signing implementation) since the two are
 * functionally identical today and differ only in secret provenance.
 */
export class EnvSignerProvider extends LocalSignerProvider {
  constructor(secretKey: string, allowedOperations: readonly string[] = DEFAULT_ALLOWED_OPERATIONS) {
    super(secretKey, allowedOperations, 'env');
  }

  static fromEnvVar(envVarName: string, allowedOperations?: readonly string[]): EnvSignerProvider {
    const secret = process.env[envVarName];
    if (!secret) {
      throw new Error(`Environment variable ${envVarName} is not set`);
    }
    return new EnvSignerProvider(secret, allowedOperations);
  }
}

/**
 * Delegates signing to an injectable async callback (e.g. a remote KMS/HSM
 * client), mirroring the SDK's `CustomSigner` pattern. Throws
 * `NotImplementedError` if no callback is supplied, so it can stand in as a
 * documented extension point without a real remote signer integration.
 */
export class ExternalSignerProvider implements SignerProvider {
  readonly id: string;
  readonly allowedOperations: ReadonlySet<string>;

  constructor(
    public readonly publicKey: string,
    allowedOperations: readonly string[],
    private readonly signCallback?: (
      unsignedXdr: string,
      networkPassphrase: string,
    ) => Promise<string>,
  ) {
    this.id = `external:${publicKey}`;
    this.allowedOperations = new Set(allowedOperations);
  }

  async sign(tx: Transaction, networkPassphrase: string): Promise<Transaction> {
    if (!this.signCallback) {
      throw new NotImplementedError(
        'ExternalSignerProvider requires an injectable sign callback; none was provided.',
      );
    }
    const signedXdr = await this.signCallback(tx.toXDR(), networkPassphrase);
    return TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as Transaction;
  }
}
