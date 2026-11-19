import {
  ContractCallTimeoutError,
  classifyContractCallError,
  markContractCallTimeout,
  type ContractCallErrorClassification,
} from "../utils/contractCallClassification";

describe("markContractCallTimeout", () => {
  it("resolves the inner promise when it settles in time", async () => {
    await expect(
      markContractCallTimeout(Promise.resolve(42), 1000),
    ).resolves.toBe(42);
  });

  it("rejects with a typed timeout error when the deadline fires", async () => {
    const slow = new Promise<never>(() => {});
    const error = await markContractCallTimeout(slow, 20).catch((e) => e);
    expect(error).toBeInstanceOf(ContractCallTimeoutError);
    expect((error as ContractCallTimeoutError).code).toBe("CONTRACT_CALL_TIMEOUT");
    expect((error as ContractCallTimeoutError).retryable).toBe(true);
    expect(typeof (error as ContractCallTimeoutError).at).toBe("string");
  });
});

describe("classifyContractCallError", () => {
  it("classifies a typed timeout as retryable timeout", () => {
    const c = classifyContractCallError(new ContractCallTimeoutError(5000));
    expect(c).toMatchObject<Partial<ContractCallErrorClassification>>({
      kind: "timeout",
      code: "CONTRACT_CALL_TIMEOUT",
      retryable: true,
    });
  });

  it("classifies request-time cache aborts as timeout", () => {
    const abort = new Error("aborted") as Error & { name: string };
    abort.name = "AbortError";
    expect(classifyContractCallError(abort).kind).toBe("timeout");
  });

  it("classifies connection errors as retryable network failures", () => {
    const err = new Error("connect ECONNREFUSED") as Error & { code: string };
    err.code = "ECONNREFUSED";
    const c = classifyContractCallError(err);
    expect(c.kind).toBe("network");
    expect(c.code).toBe("CONTRACT_CALL_NETWORK_ERROR");
    expect(c.retryable).toBe(true);
  });

  it("classifies contract-level errors as non-retryable reverts", () => {
    const err = new Error("reverted") as Error & { code: string; name: string };
    err.code = "CONTRACT_ERROR";
    err.name = "ContractError";
    const c = classifyContractCallError(err);
    expect(c.code).toBe("CONTRACT_CALL_REVERTED");
    expect(c.retryable).toBe(false);
  });

  it("never throws and falls back to unknown for opaque values", () => {
    const c = classifyContractCallError(null);
    expect(c.kind).toBe("unknown");
    expect(c.code).toBe("CONTRACT_CALL_UNKNOWN");
  });
});