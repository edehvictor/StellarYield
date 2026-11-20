import * as StellarSdk from "@stellar/stellar-sdk";
import {
  isNonceConflictResult,
  isNonceConflictError,
  isSafeToRetryAfterNonceConflict,
  submitWithNonceConflictHandling,
  NONCE_CONFLICT_CODE,
} from "../relayer/nonceConflict";

const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

function buildBadSeqTransactionResult(): StellarSdk.xdr.TransactionResult {
  return new StellarSdk.xdr.TransactionResult({
    feeCharged: StellarSdk.xdr.Int64.fromString("100"),
    result: StellarSdk.xdr.TransactionResultResult.txBadSeq(),
    ext: new StellarSdk.xdr.TransactionResultExt(0),
  });
}

function buildSuccessTransactionResult(): StellarSdk.xdr.TransactionResult {
  return new StellarSdk.xdr.TransactionResult({
    feeCharged: StellarSdk.xdr.Int64.fromString("100"),
    result: StellarSdk.xdr.TransactionResultResult.txSuccess([]),
    ext: new StellarSdk.xdr.TransactionResultExt(0),
  });
}

function buildPaymentTx(): StellarSdk.Transaction {
  const source = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(source.publicKey(), "1");
  return new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: StellarSdk.Keypair.random().publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: "10",
      }),
    )
    .setTimeout(30)
    .build();
}

function buildInvokeHostFunctionTx(): StellarSdk.Transaction {
  const source = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(source.publicKey(), "1");
  const contractId = StellarSdk.StrKey.encodeContract(
    Buffer.alloc(32, 7),
  );
  const contract = new StellarSdk.Contract(contractId);
  return new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("rebalance"))
    .setTimeout(30)
    .build();
}

describe("isNonceConflictResult (#1153)", () => {
  it("returns true for a decoded txBadSeq TransactionResult", () => {
    expect(isNonceConflictResult(buildBadSeqTransactionResult())).toBe(true);
  });

  it("returns false for a decoded txSuccess TransactionResult", () => {
    expect(isNonceConflictResult(buildSuccessTransactionResult())).toBe(false);
  });

  it("returns false for null/undefined/non-object values", () => {
    expect(isNonceConflictResult(null)).toBe(false);
    expect(isNonceConflictResult(undefined)).toBe(false);
    expect(isNonceConflictResult("txBadSeq")).toBe(false);
  });
});

describe("isNonceConflictError (#1153)", () => {
  it("detects a nonce conflict from an attached decoded errorResult", () => {
    const error = new Error("Transaction submission failed") as Error & {
      errorResult?: unknown;
    };
    error.errorResult = buildBadSeqTransactionResult();
    expect(isNonceConflictError(error)).toBe(true);
  });

  it("does not flag a non-conflict errorResult", () => {
    const error = new Error("Transaction submission failed") as Error & {
      errorResult?: unknown;
    };
    error.errorResult = buildSuccessTransactionResult();
    expect(isNonceConflictError(error)).toBe(false);
  });

  it("falls back to message matching for txBadSeq mentioned in the message", () => {
    expect(isNonceConflictError(new Error('{"result":"txBadSeq"}'))).toBe(true);
    expect(isNonceConflictError(new Error("tx_bad_seq: sequence too old"))).toBe(true);
    expect(isNonceConflictError(new Error("Bad sequence number for account"))).toBe(true);
  });

  it("does not flag unrelated errors", () => {
    expect(isNonceConflictError(new Error("Connection refused"))).toBe(false);
    expect(isNonceConflictError(new Error("Malformed XDR"))).toBe(false);
    expect(isNonceConflictError(null)).toBe(false);
  });
});

describe("isSafeToRetryAfterNonceConflict (#1153)", () => {
  it("is safe (retry-eligible) for a fingerprintable simple payment", () => {
    const tx = buildPaymentTx();
    const fingerprintFn = (t: StellarSdk.Transaction) =>
      t.operations[0]?.type === "payment" ? "fp-1" : undefined;
    expect(isSafeToRetryAfterNonceConflict(tx, fingerprintFn)).toBe(true);
  });

  it("is NOT safe for a Soroban invokeHostFunction call (fund-moving, unfingerprintable)", () => {
    const tx = buildInvokeHostFunctionTx();
    const fingerprintFn = (t: StellarSdk.Transaction) =>
      t.operations[0]?.type === "payment" ? "fp-1" : undefined;
    expect(isSafeToRetryAfterNonceConflict(tx, fingerprintFn)).toBe(false);
  });

  it("defaults to unsafe when the fingerprint function throws or returns undefined", () => {
    const tx = buildPaymentTx();
    const fingerprintFn = () => undefined;
    expect(isSafeToRetryAfterNonceConflict(tx, fingerprintFn)).toBe(false);
  });
});

describe("submitWithNonceConflictHandling (#1153)", () => {
  it("returns SUCCESS on the first attempt when submit resolves", async () => {
    const submit = jest.fn().mockResolvedValue({ hash: "abc" });
    const outcome = await submitWithNonceConflictHandling(submit, {
      retryEligible: true,
    });

    expect(outcome.status).toBe("SUCCESS");
    if (outcome.status === "SUCCESS") {
      expect(outcome.result).toEqual({ hash: "abc" });
    }
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("retries a nonce conflict for a retry-eligible transaction and succeeds", async () => {
    const conflictError = new Error("txBadSeq") as Error & { errorResult?: unknown };
    conflictError.errorResult = buildBadSeqTransactionResult();

    const submit = jest
      .fn()
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ hash: "retried-success" });

    const outcome = await submitWithNonceConflictHandling(submit, {
      retryEligible: true,
      maxRetries: 2,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("SUCCESS");
    if (outcome.status === "SUCCESS") {
      expect(outcome.result).toEqual({ hash: "retried-success" });
      expect(outcome.attempts).toHaveLength(2);
      expect(outcome.attempts[0].outcome).toBe("nonce_conflict");
      expect(outcome.attempts[1].outcome).toBe("success");
    }
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("surfaces RETRY_EXHAUSTED with attempt metadata when every retry also conflicts", async () => {
    const conflictError = new Error("txBadSeq") as Error & { errorResult?: unknown };
    conflictError.errorResult = buildBadSeqTransactionResult();

    const submit = jest.fn().mockRejectedValue(conflictError);

    const outcome = await submitWithNonceConflictHandling(submit, {
      retryEligible: true,
      maxRetries: 2,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("RETRY_EXHAUSTED");
    expect(outcome.code).toBe(NONCE_CONFLICT_CODE);
    expect(outcome.retried).toBe(true);
    expect(outcome.retryEligible).toBe(true);
    expect(outcome.reason).toMatch(/persisted/i);
    // 1 initial attempt + 2 retries = 3 total attempts recorded.
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.attempts.every((a) => a.outcome === "nonce_conflict")).toBe(true);
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry and returns UNSAFE_TO_RETRY when the transaction type is not retry-eligible", async () => {
    const conflictError = new Error("txBadSeq") as Error & { errorResult?: unknown };
    conflictError.errorResult = buildBadSeqTransactionResult();

    const submit = jest.fn().mockRejectedValue(conflictError);

    const outcome = await submitWithNonceConflictHandling(submit, {
      retryEligible: false,
      maxRetries: 2,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("UNSAFE_TO_RETRY");
    expect(outcome.code).toBe(NONCE_CONFLICT_CODE);
    expect(outcome.retried).toBe(false);
    expect(outcome.retryEligible).toBe(false);
    expect(outcome.reason).toMatch(/cannot be safely.*retried/i);
    // Only the single initial attempt — no retries were made.
    expect(outcome.attempts).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-nonce-conflict error, even when retry-eligible", async () => {
    const submit = jest.fn().mockRejectedValue(new Error("Connection refused"));

    const outcome = await submitWithNonceConflictHandling(submit, {
      retryEligible: true,
      maxRetries: 2,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.code).toBeUndefined();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("records attempt count and timestamps for every attempt", async () => {
    const conflictError = new Error("txBadSeq") as Error & { errorResult?: unknown };
    conflictError.errorResult = buildBadSeqTransactionResult();

    const submit = jest
      .fn()
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ hash: "ok" });

    const outcome = await submitWithNonceConflictHandling(submit, {
      retryEligible: true,
      maxRetries: 2,
      retryDelayMs: 0,
    });

    expect(outcome.status).toBe("SUCCESS");
    if (outcome.status === "SUCCESS") {
      outcome.attempts.forEach((a, i) => {
        expect(a.attempt).toBe(i + 1);
        expect(new Date(a.startedAt).getTime()).not.toBeNaN();
        expect(new Date(a.finishedAt).getTime()).not.toBeNaN();
      });
    }
  });
});
