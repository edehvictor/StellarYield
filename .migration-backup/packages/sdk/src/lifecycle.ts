import { rpc, TransactionBuilder, Operation, Account } from "@stellar/stellar-sdk";
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
  specHash?: string;
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

  public async submit(
    serverOrUrl: rpc.Server | { rpcUrl: string } | string
  ): Promise<SubmittedTransaction<T>> {
    const server =
      typeof serverOrUrl === "string"
        ? new rpc.Server(serverOrUrl)
        : "rpcUrl" in serverOrUrl
        ? new rpc.Server(serverOrUrl.rpcUrl)
        : serverOrUrl;

    const rpcUrl =
      typeof serverOrUrl === "string"
        ? serverOrUrl
        : "rpcUrl" in serverOrUrl
        ? serverOrUrl.rpcUrl
        : (server as any).serverURL?.toString() || "http://localhost:8000";

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

    return new SubmittedTransaction<T>(
      response.hash,
      {
        rpcUrl,
        rpcServer: typeof serverOrUrl !== "string" && !("rpcUrl" in serverOrUrl) ? server : undefined,
        networkPassphrase: this.meta.networkPassphrase,
        preparedMeta: this.meta,
      }
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
    public readonly opts: SubmittedOpts<T>
  ) {}

  public toHash(): string {
    return this.hash;
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
