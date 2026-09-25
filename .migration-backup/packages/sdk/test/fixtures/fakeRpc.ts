/**
 * Deterministic fake RPC server implementing just the `rpc.Server` surface
 * the lifecycle helpers actually call (`sendTransaction`, `getTransaction`),
 * so lifecycle tests can drive success/rejection/timeout/restore scenarios
 * without touching a real network.
 */

export interface FakeXdrResult {
  toXDR(format?: string): string;
}

export function fakeXdrResult(base64 = "AAAAAAAAAAA="): FakeXdrResult {
  return { toXDR: () => base64 };
}

export interface FakeSendTransactionResponse {
  status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
  hash: string;
  latestLedger: number;
  latestLedgerCloseTime: number;
  errorResult?: FakeXdrResult;
  diagnosticEvents?: unknown[];
}

export function fakeSendPending(hash: string): FakeSendTransactionResponse {
  return { status: "PENDING", hash, latestLedger: 1000, latestLedgerCloseTime: 0 };
}

export function fakeSendError(hash = "0000000000000000000000000000000000000000000000000000000000000000"): FakeSendTransactionResponse {
  return {
    status: "ERROR",
    hash,
    latestLedger: 1000,
    latestLedgerCloseTime: 0,
    errorResult: fakeXdrResult(),
  };
}

export interface FakeGetTransactionResponse {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  txHash: string;
  latestLedger: number;
  latestLedgerCloseTime: number;
  oldestLedger: number;
  oldestLedgerCloseTime: number;
  ledger?: number;
  resultXdr?: FakeXdrResult;
}

export function fakeGetSuccess(ledger = 4242): FakeGetTransactionResponse {
  return {
    status: "SUCCESS",
    txHash: "success",
    latestLedger: ledger,
    latestLedgerCloseTime: 0,
    oldestLedger: 0,
    oldestLedgerCloseTime: 0,
    ledger,
    resultXdr: fakeXdrResult(),
  };
}

export function fakeGetFailed(ledger = 4242): FakeGetTransactionResponse {
  return {
    status: "FAILED",
    txHash: "failed",
    latestLedger: ledger,
    latestLedgerCloseTime: 0,
    oldestLedger: 0,
    oldestLedgerCloseTime: 0,
    ledger,
    resultXdr: fakeXdrResult(),
  };
}

export function fakeGetNotFound(): FakeGetTransactionResponse {
  return {
    status: "NOT_FOUND",
    txHash: "pending",
    latestLedger: 1000,
    latestLedgerCloseTime: 0,
    oldestLedger: 0,
    oldestLedgerCloseTime: 0,
  };
}

export interface FakeRpcScript {
  /** Response(s) returned from `sendTransaction`. A function is invoked fresh each call. */
  send?: FakeSendTransactionResponse | (() => FakeSendTransactionResponse);
  /**
   * Sequence of responses returned from successive `getTransaction` polls.
   * The last entry repeats once the sequence is exhausted.
   */
  pollSequence?: FakeGetTransactionResponse[];
}

export interface FakeRpcServer {
  sendTransaction(tx: unknown): Promise<FakeSendTransactionResponse>;
  getTransaction(hash: string): Promise<FakeGetTransactionResponse>;
  readonly pollCallCount: number;
}

export function createFakeRpcServer(script: FakeRpcScript): FakeRpcServer {
  let pollIndex = 0;
  const sequence = script.pollSequence ?? [fakeGetSuccess()];

  return {
    async sendTransaction() {
      const send = script.send;
      if (typeof send === "function") return send();
      return send ?? fakeSendPending("deadbeef");
    },
    async getTransaction() {
      const response = sequence[Math.min(pollIndex, sequence.length - 1)];
      pollIndex++;
      return response;
    },
    get pollCallCount() {
      return pollIndex;
    },
  };
}
