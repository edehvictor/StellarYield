import { rpc, TransactionBuilder, Operation, Account, hash } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type { SignerAdapter } from "./signers";
import {
  SpecMismatchError,
  SubmissionTimeoutError,
  InvalidXdrError,
  parseContractError,
} from "./errors";
import { YIELD_VAULT_SPEC_HASH } from "./generated/yield_vault";

export type TransactionState =
  | "CREATED"
  | "SIMULATED"
  | "AUTHORIZED"
  | "SIGNED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED";

/**
 * Identity for one logical vault operation, shared by every retry of that
 * operation. When a caller supplies an `idempotencyKey`, the same key and the
 * same arguments produce the same `operationId`, so a retried prepare/sign/
 * submit cycle is recognized as the same effect instead of a second one.
 */
export interface OperationIdentity {
  operationId: string;
  idempotencyKey?: string;
}

export interface OperationIdentityInput {
  contractId: string;
  networkPassphrase: string;
  method: string;
  argsHash: string;
  /** Stable caller-supplied key; retries with the same key reuse the identity. */
  idempotencyKey?: string;
  /** Explicit identity for advanced callers; takes precedence over derivation. */
  operationId?: string;
}

/**
 * Derive the operation identity included in prepared-transaction metadata.
 *
 * With an `idempotencyKey`, the id is a deterministic SHA-256 of the contract,
 * network, method, argument hash, and key. Without one, a unique nonce keeps
 * otherwise-identical operations distinct. Either way the id does not appear
 * in the transaction envelope, so it adds no on-chain data.
 */
export function createOperationId(input: OperationIdentityInput): string {
  if (input.operationId) return input.operationId;

  const idempotencyKey = input.idempotencyKey?.trim();
  const nonce = idempotencyKey || createOperationNonce();
  const payload = JSON.stringify([
    input.contractId,
    input.networkPassphrase,
    input.method,
    input.argsHash,
    nonce,
  ]);
  return hash(Buffer.from(payload, "utf8")).toString("hex");
}

function createOperationNonce(): string {
  const cryptoObj = (
    globalThis as {
      crypto?: { randomUUID?: () => string };
    }
  ).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Upper bound on remembered submission identities. The registry is an
 * in-process duplicate guard, not a durable store; callers that need
 * cross-process idempotency must persist and reuse `idempotencyKey`.
 */
const MAX_TRACKED_OPERATIONS = 1000;
const submittedOperations = new Map<string, string>();

/** Submitted transaction hash for an operation id, when already seen. */
export function lookupSubmittedOperation(operationId: string): string | undefined {
  return submittedOperations.get(operationId);
}

/** Remember a successful submission so a retry reuses its transaction hash. */
export function rememberSubmittedOperation(operationId: string, txHash: string): void {
  submittedOperations.delete(operationId);
  submittedOperations.set(operationId, txHash);
  while (submittedOperations.size > MAX_TRACKED_OPERATIONS) {
    const oldest = submittedOperations.keys().next().value;
    if (oldest === undefined) break;
    submittedOperations.delete(oldest);
  }
}

/**
 * Forget an operation identity so a corrected retry may submit again. Called
 * automatically when a submitted transaction reports FAILED (no effect landed).
 */
export function forgetSubmittedOperation(operationId: string): void {
  submittedOperations.delete(operationId);
}

/** Clear the in-process duplicate-submission guard (tests or explicit recovery). */
export function resetSubmittedOperations(): void {
  submittedOperations.clear();
}

export interface PreparedTransactionMeta<T> {
  simulationResult: T;
  footprint: string;
  authEntries: string[];
  minResourceFee: string;
  transactionData: string;
  latestLedger: number;
  validUntilLedger: number;
  contractId: string;
  networkPassphrase: string;
  method: string;
  argsHash: string;
  /** Stable identity for this logical operation; reused across safe retries. */
  operationId?: string;
  /** Caller-supplied idempotency key that produced `operationId`. */
  idempotencyKey?: string;
  specHash?: string;
  configFingerprint?: string;
}

export class PreparedTransaction<T = unknown> {
  public readonly state: TransactionState = "SIMULATED";

  constructor(
    public readonly xdr: string,
    public readonly meta: PreparedTransactionMeta<T>
  ) {
    if (meta.specHash && meta.specHash !== YIELD_VAULT_SPEC_HASH) {
      throw new SpecMismatchError(YIELD_VAULT_SPEC_HASH, meta.specHash);
    }
  }

  public toXDR(): string {
    return this.xdr;
  }

  /** Stable operation identity carried into submit-time duplicate checks. */
  public get operationId(): string | undefined {
    return this.meta.operationId;
  }

  public static fromXDR<T>(
    xdrString: string,
    meta: PreparedTransactionMeta<T>
  ): PreparedTransaction<T> {
    try {
      TransactionBuilder.fromXDR(xdrString, meta.networkPassphrase);
    } catch (e) {
      throw new InvalidXdrError(
        xdrString,
        e instanceof Error ? e.message : String(e)
      );
    }
    return new PreparedTransaction<T>(xdrString, meta);
  }

  public async sign(signer: SignerAdapter): Promise<SignedTransaction<T>> {
    const signedXdr = await signer.signTransaction(this.xdr, {
      networkPassphrase: this.meta.networkPassphrase,
      contractId: this.meta.contractId,
    });
    return new SignedTransaction<T>(signedXdr, this.meta, this.xdr);
  }
}

export class SignedTransaction<T = unknown> {
  public readonly state: TransactionState = "SIGNED";
  /** Concurrent calls to submit() share one network request. */
  private inFlightSubmission?: Promise<SubmittedTransaction<T>>;

  constructor(
    public readonly signedXdr: string,
    public readonly meta: PreparedTransactionMeta<T>,
    public readonly originalUnsignedXdr?: string
  ) {
    this.validateInvariant();
  }

  private validateInvariant(): void {
    try {
      const parsedSigned = TransactionBuilder.fromXDR(
        this.signedXdr,
        this.meta.networkPassphrase
      );
      if (this.originalUnsignedXdr) {
        const parsedUnsigned = TransactionBuilder.fromXDR(
          this.originalUnsignedXdr,
          this.meta.networkPassphrase
        );
        if (parsedSigned.hash().toString("hex") === parsedUnsigned.hash().toString("hex")) {
          // Both have same hash signature base
        }
      }
    } catch (e) {
      throw new InvalidXdrError(
        this.signedXdr,
        `Signed XDR validation failed for network ${this.meta.networkPassphrase}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  public toXDR(): string {
    return this.signedXdr;
  }

  public static fromXDR<T>(
    signedXdr: string,
    meta: PreparedTransactionMeta<T>
  ): SignedTransaction<T> {
    return new SignedTransaction<T>(signedXdr, meta);
  }

  /**
   * Submit once per operation identity.
   *
   * A retry that presents an already-submitted `operationId` (for example a
   * caller reusing an `idempotencyKey`, or a second `.submit()` on the same
   * prepared transaction) returns the original transaction hash without
   * calling `sendTransaction` again. Concurrent calls share one request. A
   * submission that never reached the network is not remembered, so retrying
   * after a transport failure still works.
   */
  public async submit(
    serverOrUrl: rpc.Server | { rpcUrl: string } | string
  ): Promise<SubmittedTransaction<T>> {
    const operationId = this.resolveOperationId();
    const existingHash = lookupSubmittedOperation(operationId);
    if (existingHash) {
      return new SubmittedTransaction<T>(
        existingHash,
        this.buildSubmittedOpts(serverOrUrl),
        true
      );
    }

    if (this.inFlightSubmission) return this.inFlightSubmission;

    this.inFlightSubmission = this.performSubmit(serverOrUrl, operationId).finally(() => {
      this.inFlightSubmission = undefined;
    });
    return this.inFlightSubmission;
  }

  private resolveOperationId(): string {
    if (this.meta.operationId) return this.meta.operationId;
    // No prepared identity: the signed transaction hash itself is unique, so
    // duplicate submits of this exact envelope are still suppressed.
    const tx = TransactionBuilder.fromXDR(this.signedXdr, this.meta.networkPassphrase);
    return `tx:${tx.hash().toString("hex")}`;
  }

  private buildSubmittedOpts(
    serverOrUrl: rpc.Server | { rpcUrl: string } | string,
    server?: rpc.Server
  ): SubmittedOpts<T> {
    const serverInstance =
      server ??
      (typeof serverOrUrl !== "string" && !("rpcUrl" in serverOrUrl)
        ? serverOrUrl
        : undefined);

    const rpcUrl =
      typeof serverOrUrl === "string"
        ? serverOrUrl
        : "rpcUrl" in serverOrUrl
        ? serverOrUrl.rpcUrl
        : (serverInstance as any)?.serverURL?.toString() || "http://localhost:8000";

    return {
      rpcUrl,
      rpcServer: serverInstance,
      networkPassphrase: this.meta.networkPassphrase,
      preparedMeta: this.meta,
    };
  }

  private async performSubmit(
    serverOrUrl: rpc.Server | { rpcUrl: string } | string,
    operationId: string
  ): Promise<SubmittedTransaction<T>> {
    const server =
      typeof serverOrUrl === "string"
        ? new rpc.Server(serverOrUrl)
        : "rpcUrl" in serverOrUrl
        ? new rpc.Server(serverOrUrl.rpcUrl)
        : serverOrUrl;

    const tx = TransactionBuilder.fromXDR(this.signedXdr, this.meta.networkPassphrase);
    const response = await server.sendTransaction(tx);

    if (response.status === "ERROR") {
      const rawResultXdr = response.errorResult?.toXDR("base64");
      const diagEvents = response.diagnosticEvents?.map((ev) => ev.toXDR("base64"));
      throw parseContractError(
        new Error(`RPC submission error (${response.status}): ${JSON.stringify(response)}`),
        rawResultXdr,
        diagEvents
      );
    }

    rememberSubmittedOperation(operationId, response.hash);
    return new SubmittedTransaction<T>(
      response.hash,
      this.buildSubmittedOpts(serverOrUrl, server)
    );
  }
}

export interface SubmittedOpts<T> {
  rpcUrl: string;
  networkPassphrase: string;
  preparedMeta?: PreparedTransactionMeta<T>;
  /** Optional pre-constructed/injectable RPC client, e.g. a test double. Falls back to `new rpc.Server(rpcUrl)` when omitted. */
  rpcServer?: rpc.Server;
}

export class SubmittedTransaction<T = unknown> {
  public readonly state: TransactionState = "SUBMITTED";

  constructor(
    public readonly hash: string,
    public readonly opts: SubmittedOpts<T>,
    /** True when this result reused an earlier submission of the same operation. */
    public readonly deduplicated = false
  ) {}

  public toHash(): string {
    return this.hash;
  }

  /** Operation identity shared with the prepared transaction, when present. */
  public get operationId(): string | undefined {
    return this.opts.preparedMeta?.operationId;
  }

  public static fromHash<T>(
    hash: string,
    opts: SubmittedOpts<T>
  ): SubmittedTransaction<T> {
    return new SubmittedTransaction<T>(hash, opts);
  }

  public async wait(options?: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ConfirmedTransaction<T>> {
    const pollInterval = options?.pollIntervalMs ?? 1000;
    const timeout = options?.timeoutMs ?? 30000;
    const startTime = Date.now();
    const server = this.opts.rpcServer ?? new rpc.Server(this.opts.rpcUrl);

    while (Date.now() - startTime < timeout) {
      if (options?.signal?.aborted) {
        throw new Error("Transaction wait aborted by caller");
      }

      const txStatus = await server.getTransaction(this.hash);

      if (txStatus.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const resultValue = this.opts.preparedMeta?.simulationResult as T;
        const resultXdr = txStatus.resultXdr?.toXDR("base64");

        return new ConfirmedTransaction<T>(
          this.hash,
          txStatus.ledger,
          resultValue,
          resultXdr || ""
        );
      }

      if (txStatus.status === rpc.Api.GetTransactionStatus.FAILED) {
        // The network reports no effect for a FAILED transaction, so allow a
        // corrected retry to use the same operation identity again.
        const operationId = this.operationId;
        if (operationId) forgetSubmittedOperation(operationId);

        const resultXdr = txStatus.resultXdr?.toXDR("base64");
        throw parseContractError(
          new Error(`Transaction failed on ledger ${txStatus.ledger}`),
          resultXdr,
          undefined,
          "poll"
        );
      }

      // NOT_FOUND (or any other transient status): still pending inclusion, keep polling.
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new SubmissionTimeoutError(this.hash, timeout);
  }
}

/**
 * True when a simulation response indicates expired ledger entries in the
 * transaction's footprint must be restored before the operation can succeed.
 */
export function needsRestore(
  simulation: rpc.Api.SimulateTransactionResponse | undefined
): simulation is rpc.Api.SimulateTransactionRestoreResponse {
  return !!simulation && rpc.Api.isSimulationRestore(simulation);
}

/**
 * Given a restore preamble from a `SimulateTransactionRestoreResponse`
 * (surfaced to callers via `RestoreRequiredError.restorePreamble`), builds,
 * signs, submits, and awaits a `RestoreFootprintOp` transaction that brings
 * the expired ledger entries back into scope. On success, the caller should
 * simply retry its original prepare call (`vaultClient.deposit.prepare(...)`,
 * etc.) — the entries will simulate successfully now.
 */
export async function restoreAndRetry(params: {
  restorePreamble: { minResourceFee: string; transactionData: { build(): unknown } };
  sourceAccount: Account;
  networkPassphrase: string;
  signer: SignerAdapter;
  server: rpc.Server;
  contractId?: string;
}): Promise<ConfirmedTransaction<void>> {
  const { restorePreamble, sourceAccount, networkPassphrase, signer, server, contractId } = params;

  const restoreTx = new TransactionBuilder(sourceAccount, {
    fee: restorePreamble.minResourceFee,
    networkPassphrase,
  })
    .addOperation(Operation.restoreFootprint({}))
    .setSorobanData(restorePreamble.transactionData.build() as any)
    .setTimeout(30)
    .build();

  const signedXdr = await signer.signTransaction(restoreTx.toXDR(), {
    networkPassphrase,
    contractId,
  });

  const signed = new SignedTransaction<void>(signedXdr, {
    simulationResult: undefined as unknown as void,
    footprint: "",
    authEntries: [],
    minResourceFee: restorePreamble.minResourceFee,
    transactionData: "",
    latestLedger: 0,
    validUntilLedger: 0,
    contractId: contractId ?? "",
    networkPassphrase,
    method: "restore_footprint",
    argsHash: "",
  });

  const submitted = await signed.submit(server);
  return submitted.wait();
}

export class ConfirmedTransaction<T = unknown> {
  public readonly state: TransactionState = "CONFIRMED";

  constructor(
    public readonly hash: string,
    public readonly ledger: number,
    public readonly result: T,
    public readonly rawResultXdr: string
  ) {}
}
