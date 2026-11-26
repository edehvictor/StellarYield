import { Keypair, TransactionBuilder, Networks, hash } from "@stellar/stellar-sdk";
import {
  WalletRejectedError,
  InvalidXdrError,
  DuplicateSubmissionError,
  SignerOperationConflictError,
  SignerValidationError,
} from "./errors";

// ── Types & Options ──────────────────────────────────────────────────────────

export interface SignTransactionOptions {
  networkPassphrase: string;
  contractId?: string;
  /**
   * Explicit operation identifier to enforce idempotency.
   * When provided, duplicate calls return the committed signed XDR without re-signing.
   */
  operationId?: string;
  /**
   * Optional pre-sign validation hook. If this returns false or throws,
   * signing is aborted immediately, preserving state and balances without applying effects.
   */
  validate?: () => boolean | string | void;
  /**
   * Set to true to bypass duplicate detection and force fresh signing.
   */
  bypassIdempotency?: boolean;
  [key: string]: unknown;
}

export interface SignerAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(
    unsignedXdr: string,
    opts: SignTransactionOptions
  ): Promise<string>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
  switchNetwork?(networkPassphrase: string): Promise<void>;
  getOperationManager?(): SignerOperationManager;
}

// ── Operation Identity & Effects (#1861) ─────────────────────────────────────

export interface SignerOperationIdentity {
  readonly operationId: string;
  readonly payloadFingerprint: string;
  readonly shortId: string;
  readonly publicKey?: string;
  readonly txHash?: string;
  readonly createdAt: string;
}

export interface SignerOperationEffect {
  readonly effectId: string;
  readonly type: "TRANSACTION_SIGNED" | "SIGNATURE_RECORDED" | "SUBMISSION_DISPATCHED";
  readonly operationId: string;
  readonly txHash?: string;
  readonly signedXdr?: string;
  readonly appliedAt: string;
}

export type SignerOperationStatus = "in_flight" | "committed" | "failed" | "rejected";

export interface SignerOperationRecord {
  operationId: string;
  payloadFingerprint: string;
  status: SignerOperationStatus;
  publicKey?: string;
  signedXdr?: string;
  txHash?: string;
  effects: SignerOperationEffect[];
  error?: string;
  errorCode?: string;
  createdAt: string;
  committedAt?: string;
  replayedCount: number;
}

/**
 * Computes a deterministic SHA-256 fingerprint for a signer submission payload.
 */
export function computeSignerPayloadFingerprint(
  unsignedXdr: string,
  networkPassphrase: string,
  contractId?: string
): { fingerprint: string; shortId: string; txHash?: string } {
  let txHash: string | undefined;
  try {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
    txHash = tx.hash().toString("hex");
  } catch {
    // If not valid XDR yet, txHash remains undefined
  }

  const normalizedPayload = `${networkPassphrase}:${contractId || ""}:${unsignedXdr.trim()}`;
  const fingerprint = hash(Buffer.from(normalizedPayload)).toString("hex");
  const shortId = `sop-${fingerprint.slice(0, 6)}…${fingerprint.slice(-4)}`;

  return { fingerprint, shortId, txHash };
}

/**
 * Creates an immutable operation identity for a signer submission.
 */
export function createSignerOperationIdentity(
  unsignedXdr: string,
  opts: {
    networkPassphrase: string;
    contractId?: string;
    operationId?: string;
    publicKey?: string;
  }
): SignerOperationIdentity {
  const { fingerprint, shortId, txHash } = computeSignerPayloadFingerprint(
    unsignedXdr,
    opts.networkPassphrase,
    opts.contractId
  );

  const operationId =
    opts.operationId && opts.operationId.trim() !== ""
      ? opts.operationId.trim()
      : `sop_${fingerprint.slice(0, 16)}_${Date.now()}`;

  return Object.freeze({
    operationId,
    payloadFingerprint: fingerprint,
    shortId,
    publicKey: opts.publicKey,
    txHash,
    createdAt: new Date().toISOString(),
  });
}

// ── State Preservation & Safe Execution ──────────────────────────────────────

export interface SafeSignerSubmissionOptions<TState, TResult = string> {
  signer: SignerAdapter;
  unsignedXdr: string;
  networkPassphrase: string;
  contractId?: string;
  operationId?: string;
  currentState: TState;
  validate?: (state: TState, unsignedXdr: string) => boolean | string | void;
  execute?: (signedXdr: string, identity: SignerOperationIdentity) => Promise<TResult> | TResult;
  onSuccessStateUpdate?: (currentState: TState, signedXdr: string, result?: TResult) => TState;
}

export interface SafeSignerSubmissionResult<TState, TResult = string> {
  success: boolean;
  state: TState;
  signedXdr?: string;
  result?: TResult;
  identity: SignerOperationIdentity;
  effects?: SignerOperationEffect[];
  replayed: boolean;
  duplicate: boolean;
  error?: string;
  errorCode?:
    | "VALIDATION_FAILED"
    | "EXECUTION_FAILED"
    | "OPERATION_IDENTITY_CONFLICT"
    | "DUPLICATE_SUBMISSION_IN_PROGRESS";
  isRecoverable: boolean;
}

/**
 * Manager tracking signer operations for duplicate prevention and safe retries (#1861).
 */
export class SignerOperationManager {
  private readonly operations = new Map<string, SignerOperationRecord>();

  constructor(private readonly ttlMs: number = 24 * 60 * 60 * 1000) {}

  public getOperation(operationId: string): SignerOperationRecord | undefined {
    return this.operations.get(operationId);
  }

  public clear(): void {
    this.operations.clear();
  }

  public recordInFlight(identity: SignerOperationIdentity): void {
    this.operations.set(identity.operationId, {
      operationId: identity.operationId,
      payloadFingerprint: identity.payloadFingerprint,
      status: "in_flight",
      publicKey: identity.publicKey,
      txHash: identity.txHash,
      effects: [],
      createdAt: identity.createdAt,
      replayedCount: 0,
    });
  }

  public recordCommitted(
    identity: SignerOperationIdentity,
    signedXdr: string,
    effects?: SignerOperationEffect[]
  ): SignerOperationRecord {
    const defaultEffect: SignerOperationEffect = {
      effectId: `eff_${identity.operationId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`,
      type: "TRANSACTION_SIGNED",
      operationId: identity.operationId,
      txHash: identity.txHash,
      signedXdr,
      appliedAt: new Date().toISOString(),
    };

    const record: SignerOperationRecord = {
      operationId: identity.operationId,
      payloadFingerprint: identity.payloadFingerprint,
      status: "committed",
      publicKey: identity.publicKey,
      signedXdr,
      txHash: identity.txHash,
      effects: effects && effects.length > 0 ? effects : [defaultEffect],
      createdAt: this.operations.get(identity.operationId)?.createdAt || identity.createdAt,
      committedAt: new Date().toISOString(),
      replayedCount: 0,
    };
    this.operations.set(identity.operationId, record);
    return record;
  }

  public recordFailed(
    identity: SignerOperationIdentity,
    error: string,
    errorCode = "EXECUTION_FAILED"
  ): SignerOperationRecord {
    const record: SignerOperationRecord = {
      operationId: identity.operationId,
      payloadFingerprint: identity.payloadFingerprint,
      status: "failed",
      publicKey: identity.publicKey,
      txHash: identity.txHash,
      effects: [],
      error,
      errorCode,
      createdAt: this.operations.get(identity.operationId)?.createdAt || identity.createdAt,
      replayedCount: 0,
    };
    this.operations.set(identity.operationId, record);
    return record;
  }

  public recordRejected(
    identity: SignerOperationIdentity,
    reason: string
  ): SignerOperationRecord {
    const record: SignerOperationRecord = {
      operationId: identity.operationId,
      payloadFingerprint: identity.payloadFingerprint,
      status: "rejected",
      publicKey: identity.publicKey,
      txHash: identity.txHash,
      effects: [],
      error: reason,
      errorCode: "VALIDATION_FAILED",
      createdAt: this.operations.get(identity.operationId)?.createdAt || identity.createdAt,
      replayedCount: 0,
    };
    this.operations.set(identity.operationId, record);
    return record;
  }

  /**
   * Safely executes a signer submission with duplicate prevention and atomic state preservation.
   */
  public async executeSafeSubmission<TState, TResult = string>(
    options: SafeSignerSubmissionOptions<TState, TResult>
  ): Promise<SafeSignerSubmissionResult<TState, TResult>> {
    const {
      signer,
      unsignedXdr,
      networkPassphrase,
      contractId,
      operationId,
      currentState,
      validate,
      execute,
      onSuccessStateUpdate,
    } = options;

    let publicKey: string | undefined;
    try {
      publicKey = await signer.getPublicKey();
    } catch {
      // PublicKey might not be available yet if disconnected
    }

    const identity = createSignerOperationIdentity(unsignedXdr, {
      networkPassphrase,
      contractId,
      operationId,
      publicKey,
    });

    // 1. Check for existing operation
    const existing = this.operations.get(identity.operationId);
    if (existing) {
      // Conflict check: Same operation ID used with different payload
      if (existing.payloadFingerprint !== identity.payloadFingerprint) {
        return {
          success: false,
          state: currentState, // Preserved untouched
          identity,
          error: "Operation identity conflict: parameters do not match initial submission.",
          errorCode: "OPERATION_IDENTITY_CONFLICT",
          replayed: false,
          duplicate: false,
          isRecoverable: false,
        };
      }

      // In-flight check: Concurrent duplicate submission
      if (existing.status === "in_flight") {
        return {
          success: false,
          state: currentState, // Preserved untouched
          identity,
          error: "Signer submission is already in progress.",
          errorCode: "DUPLICATE_SUBMISSION_IN_PROGRESS",
          replayed: false,
          duplicate: true,
          isRecoverable: true,
        };
      }

      // Committed replay: Return cached result without duplicate execution or state changes
      if (existing.status === "committed") {
        existing.replayedCount += 1;
        return {
          success: true,
          state: currentState, // Preserved untouched - no duplicate state mutation
          signedXdr: existing.signedXdr,
          identity,
          effects: existing.effects,
          replayed: true,
          duplicate: true,
          isRecoverable: false,
        };
      }
    }

    // 2. Validate payload and state before signing
    if (validate) {
      try {
        const val = validate(currentState, unsignedXdr);
        if (val !== true && val !== undefined) {
          const errorMsg = typeof val === "string" ? val : "Signer validation failed.";
          this.recordRejected(identity, errorMsg);
          return {
            success: false,
            state: currentState, // Preserved untouched
            identity,
            error: errorMsg,
            errorCode: "VALIDATION_FAILED",
            replayed: false,
            duplicate: false,
            isRecoverable: true,
          };
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.recordRejected(identity, errorMsg);
        return {
          success: false,
          state: currentState, // Preserved untouched
          identity,
          error: errorMsg,
          errorCode: "VALIDATION_FAILED",
          replayed: false,
          duplicate: false,
          isRecoverable: true,
        };
      }
    }

    // Mark as in-flight
    this.recordInFlight(identity);

    try {
      // 3. Execute signing through adapter
      const signedXdr = await signer.signTransaction(unsignedXdr, {
        networkPassphrase,
        contractId,
        operationId: identity.operationId,
        bypassIdempotency: true,
      });

      // 4. Optional secondary execution hook (e.g. on-chain dispatch or broadcast)
      let execResult: TResult | undefined;
      if (execute) {
        execResult = await execute(signedXdr, identity);
      }

      // 5. Commit record and atomic effect
      const record = this.recordCommitted(identity, signedXdr);

      // 6. Update state atomically on success
      const nextState = onSuccessStateUpdate
        ? onSuccessStateUpdate(currentState, signedXdr, execResult)
        : currentState;

      return {
        success: true,
        state: nextState,
        signedXdr,
        result: execResult,
        identity,
        effects: record.effects,
        replayed: false,
        duplicate: false,
        isRecoverable: false,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.recordFailed(identity, errorMsg);

      return {
        success: false,
        state: currentState, // Preserved untouched
        identity,
        error: errorMsg,
        errorCode: "EXECUTION_FAILED",
        replayed: false,
        duplicate: false,
        isRecoverable: true,
      };
    }
  }
}

export const defaultSignerOperationManager = new SignerOperationManager();

export async function executeSafeSignerSubmission<TState, TResult = string>(
  options: SafeSignerSubmissionOptions<TState, TResult>,
  manager: SignerOperationManager = defaultSignerOperationManager
): Promise<SafeSignerSubmissionResult<TState, TResult>> {
  return manager.executeSafeSubmission(options);
}

// ── Idempotent Signer Decorator ──────────────────────────────────────────────

/**
 * Decorator wrapping any SignerAdapter to enforce duplicate submission protection (#1861).
 */
export class IdempotentSignerAdapter implements SignerAdapter {
  constructor(
    public readonly innerSigner: SignerAdapter,
    public readonly manager: SignerOperationManager = defaultSignerOperationManager
  ) {}

  public static wrap(
    signer: SignerAdapter,
    manager?: SignerOperationManager
  ): IdempotentSignerAdapter {
    if (signer instanceof IdempotentSignerAdapter) {
      return signer;
    }
    return new IdempotentSignerAdapter(signer, manager);
  }

  async getPublicKey(): Promise<string> {
    return this.innerSigner.getPublicKey();
  }

  async signTransaction(
    unsignedXdr: string,
    opts: SignTransactionOptions
  ): Promise<string> {
    if (opts.bypassIdempotency) {
      return this.innerSigner.signTransaction(unsignedXdr, opts);
    }

    let publicKey: string | undefined;
    try {
      publicKey = await this.innerSigner.getPublicKey();
    } catch {
      // ignore if not yet connected
    }

    const identity = createSignerOperationIdentity(unsignedXdr, {
      networkPassphrase: opts.networkPassphrase,
      contractId: opts.contractId,
      operationId: opts.operationId,
      publicKey,
    });

    const existing = this.manager.getOperation(identity.operationId);
    if (existing) {
      if (existing.payloadFingerprint !== identity.payloadFingerprint) {
        throw new SignerOperationConflictError(identity.operationId);
      }
      if (existing.status === "in_flight") {
        throw new DuplicateSubmissionError(identity.operationId, "in_flight");
      }
      if (existing.status === "committed" && existing.signedXdr) {
        existing.replayedCount += 1;
        return existing.signedXdr;
      }
    }

    if (opts.validate) {
      const val = opts.validate();
      if (val !== true && val !== undefined) {
        const errorMsg = typeof val === "string" ? val : "Pre-sign validation failed";
        this.manager.recordRejected(identity, errorMsg);
        throw new SignerValidationError(errorMsg, identity.operationId);
      }
    }

    this.manager.recordInFlight(identity);

    try {
      const signedXdr = await this.innerSigner.signTransaction(unsignedXdr, {
        ...opts,
        bypassIdempotency: true,
      });
      this.manager.recordCommitted(identity, signedXdr);
      return signedXdr;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.manager.recordFailed(identity, errorMsg);
      throw err;
    }
  }

  async connect(): Promise<void> {
    if (this.innerSigner.connect) {
      await this.innerSigner.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.innerSigner.disconnect) {
      await this.innerSigner.disconnect();
    }
  }

  async switchNetwork(networkPassphrase: string): Promise<void> {
    if (this.innerSigner.switchNetwork) {
      await this.innerSigner.switchNetwork(networkPassphrase);
    }
  }

  getOperationManager(): SignerOperationManager {
    return this.manager;
  }
}

// ── Built-in Signer Implementations ──────────────────────────────────────────

async function handleSignerIdempotency(
  unsignedXdr: string,
  opts: SignTransactionOptions,
  publicKey: string | undefined,
  manager: SignerOperationManager,
  signFn: () => Promise<string>
): Promise<string> {
  if (opts.bypassIdempotency || !opts.operationId) {
    if (opts.validate) {
      const val = opts.validate();
      if (val !== true && val !== undefined) {
        throw new SignerValidationError(
          typeof val === "string" ? val : "Validation failed"
        );
      }
    }
    return signFn();
  }

  const identity = createSignerOperationIdentity(unsignedXdr, {
    networkPassphrase: opts.networkPassphrase,
    contractId: opts.contractId,
    operationId: opts.operationId,
    publicKey,
  });

  const existing = manager.getOperation(identity.operationId);
  if (existing) {
    if (existing.payloadFingerprint !== identity.payloadFingerprint) {
      throw new SignerOperationConflictError(identity.operationId);
    }
    if (existing.status === "in_flight") {
      throw new DuplicateSubmissionError(identity.operationId, "in_flight");
    }
    if (existing.status === "committed" && existing.signedXdr) {
      existing.replayedCount += 1;
      return existing.signedXdr;
    }
  }

  if (opts.validate) {
    const val = opts.validate();
    if (val !== true && val !== undefined) {
      const errorMsg = typeof val === "string" ? val : "Pre-sign validation failed";
      manager.recordRejected(identity, errorMsg);
      throw new SignerValidationError(errorMsg, identity.operationId);
    }
  }

  manager.recordInFlight(identity);

  try {
    const signedXdr = await signFn();
    manager.recordCommitted(identity, signedXdr);
    return signedXdr;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    manager.recordFailed(identity, errorMsg);
    throw err;
  }
}

export class ServerKeypairSigner implements SignerAdapter {
  constructor(
    private readonly keypair: Keypair,
    private readonly manager: SignerOperationManager = defaultSignerOperationManager
  ) {}

  public static fromSecret(
    secretKey: string,
    manager?: SignerOperationManager
  ): ServerKeypairSigner {
    return new ServerKeypairSigner(Keypair.fromSecret(secretKey), manager);
  }

  public static random(manager?: SignerOperationManager): ServerKeypairSigner {
    return new ServerKeypairSigner(Keypair.random(), manager);
  }

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signTransaction(
    unsignedXdr: string,
    opts: SignTransactionOptions
  ): Promise<string> {
    return handleSignerIdempotency(
      unsignedXdr,
      opts,
      this.keypair.publicKey(),
      this.manager,
      async () => {
        try {
          const tx = TransactionBuilder.fromXDR(unsignedXdr, opts.networkPassphrase);
          tx.sign(this.keypair);
          return tx.toXDR();
        } catch (error) {
          throw new InvalidXdrError(
            unsignedXdr,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    );
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async switchNetwork(_networkPassphrase: string): Promise<void> {}
  getOperationManager(): SignerOperationManager {
    return this.manager;
  }
}

export class CustomSigner implements SignerAdapter {
  constructor(
    private readonly publicKey: string,
    private readonly signFn: (
      unsignedXdr: string,
      networkPassphrase: string
    ) => Promise<string>,
    private readonly manager: SignerOperationManager = defaultSignerOperationManager
  ) {}

  async getPublicKey(): Promise<string> {
    return this.publicKey;
  }

  async signTransaction(
    unsignedXdr: string,
    opts: SignTransactionOptions
  ): Promise<string> {
    return handleSignerIdempotency(
      unsignedXdr,
      opts,
      this.publicKey,
      this.manager,
      async () => {
        try {
          return await this.signFn(unsignedXdr, opts.networkPassphrase);
        } catch (error) {
          throw new WalletRejectedError(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    );
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async switchNetwork(_networkPassphrase: string): Promise<void> {}
  getOperationManager(): SignerOperationManager {
    return this.manager;
  }
}

export class FreighterSigner implements SignerAdapter {
  private publicKeyCache?: string;

  constructor(
    private readonly freighterApi?: {
      getPublicKey: () => Promise<string>;
      signTransaction: (
        xdr: string,
        opts: { networkPassphrase: string }
      ) => Promise<string>;
      isAllowed?: () => Promise<boolean>;
      connect?: () => Promise<void>;
      disconnect?: () => Promise<void>;
      switchNetwork?: (networkPassphrase: string) => Promise<void>;
    },
    private readonly manager: SignerOperationManager = defaultSignerOperationManager
  ) {}

  private getApi() {
    if (this.freighterApi) {
      return this.freighterApi;
    }
    const globalObj = typeof globalThis !== "undefined" ? (globalThis as any) : {};
    if (globalObj.freighter) {
      return globalObj.freighter;
    }
    throw new WalletRejectedError(
      "Freighter wallet is not installed or unavailable in current environment."
    );
  }

  async getPublicKey(): Promise<string> {
    if (this.publicKeyCache) {
      return this.publicKeyCache;
    }
    const api = this.getApi();
    try {
      const pubKey = await api.getPublicKey();
      if (!pubKey) {
        throw new WalletRejectedError("Freighter returned empty public key");
      }
      this.publicKeyCache = pubKey;
      return pubKey;
    } catch (err) {
      if (err instanceof WalletRejectedError) {
        throw err;
      }
      throw new WalletRejectedError(
        `Failed to retrieve public key from Freighter: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async signTransaction(
    unsignedXdr: string,
    opts: SignTransactionOptions
  ): Promise<string> {
    return handleSignerIdempotency(
      unsignedXdr,
      opts,
      this.publicKeyCache,
      this.manager,
      async () => {
        const api = this.getApi();
        try {
          const signedXdr = await api.signTransaction(unsignedXdr, {
            networkPassphrase: opts.networkPassphrase,
          });
          if (!signedXdr) {
            throw new WalletRejectedError("Freighter returned empty signed XDR string");
          }
          return signedXdr;
        } catch (err) {
          if (err instanceof WalletRejectedError) {
            throw err;
          }
          throw new WalletRejectedError(
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    );
  }

  async connect(): Promise<void> {
    const api = this.getApi();
    if (api.connect) {
      await api.connect();
    }
  }

  async disconnect(): Promise<void> {
    const api = this.getApi();
    if (api.disconnect) {
      await api.disconnect();
    }
  }

  async switchNetwork(networkPassphrase: string): Promise<void> {
    const api = this.getApi();
    if (api.switchNetwork) {
      await api.switchNetwork(networkPassphrase);
    }
  }

  getOperationManager(): SignerOperationManager {
    return this.manager;
  }
}

export function createTestKeypairSigner(): ServerKeypairSigner {
  return ServerKeypairSigner.random();
}
