/**
 * Typed error mapping for failed token allowance checks (#1395).
 *
 * The allowance reader must reduce every outcome to a stable typed result and
 * never surface raw provider text. Contract failures are decoded from their
 * structured ScError, not from the RPC error string.
 */
import {
  checkTokenAllowance,
  readTokenAllowance,
  parseAllowanceValue,
  type TokenAllowanceRequest,
} from "../services/tokenAllowanceService";
import { simulateReadOnlyCall } from "../services/sorobanReader";
import { mapAllowanceFailure } from "../../../shared/types/tokenAllowance";

jest.mock("../services/sorobanReader", () => ({
  simulateReadOnlyCall: jest.fn(),
  addressArg: jest.fn((address: string) => address),
}));

const mockSimulate = simulateReadOnlyCall as jest.MockedFunction<typeof simulateReadOnlyCall>;

const request: TokenAllowanceRequest = {
  tokenContractId: "CTOKEN",
  owner: "GOWNER",
  spender: "CSPENDER",
};

beforeEach(() => {
  mockSimulate.mockReset();
});

describe("parseAllowanceValue", () => {
  it("accepts bigint, integer number and digit strings", () => {
    expect(parseAllowanceValue(5000n)).toBe(5000n);
    expect(parseAllowanceValue(42)).toBe(42n);
    expect(parseAllowanceValue("1000000")).toBe(1000000n);
  });

  it("rejects negative, fractional, and non-numeric values", () => {
    expect(parseAllowanceValue(-1n)).toBeNull();
    expect(parseAllowanceValue(1.5)).toBeNull();
    expect(parseAllowanceValue("abc")).toBeNull();
    expect(parseAllowanceValue(null)).toBeNull();
    expect(parseAllowanceValue(undefined)).toBeNull();
  });
});

describe("checkTokenAllowance", () => {
  it("returns sufficient when the allowance covers the requirement", async () => {
    mockSimulate.mockResolvedValue({ ok: true, value: 5000n });

    const outcome = await checkTokenAllowance(request, 1000n);

    expect(outcome).toEqual({
      ok: true,
      allowance: 5000n,
      required: 1000n,
      sufficient: true,
      shortfall: 0n,
    });
  });

  it("treats an exact allowance as sufficient", async () => {
    mockSimulate.mockResolvedValue({ ok: true, value: 1000n });

    const outcome = await checkTokenAllowance(request, 1000n);

    expect(outcome).toMatchObject({ ok: true, sufficient: true, shortfall: 0n });
  });

  it("maps a shortfall to a typed INSUFFICIENT_ALLOWANCE error", async () => {
    mockSimulate.mockResolvedValue({ ok: true, value: 300n });

    const outcome = await checkTokenAllowance(request, 1000n);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({
      code: "INSUFFICIENT_ALLOWANCE",
      required: 1000n,
      available: 300n,
      shortfall: 700n,
      retryable: false,
    });
  });

  it("rejects a non-positive required amount without reading the chain", async () => {
    const outcome = await checkTokenAllowance(request, 0n);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("INVALID_ALLOWANCE_AMOUNT");
    expect(mockSimulate).not.toHaveBeenCalled();
  });
});

describe("readTokenAllowance failure mapping", () => {
  it("maps a timeout to ALLOWANCE_READ_TIMEOUT", async () => {
    mockSimulate.mockResolvedValue({
      ok: false,
      reason: "timeout",
      classification: { kind: "timeout", code: "RPC_TIMEOUT", retryable: true, message: "timeout" },
    } as never);

    const outcome = await readTokenAllowance(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("ALLOWANCE_READ_TIMEOUT");
    expect(outcome.error.retryable).toBe(true);
  });

  it("maps an unreachable RPC to ALLOWANCE_READ_FAILED", async () => {
    mockSimulate.mockResolvedValue({ ok: false, reason: "unreachable" });

    const outcome = await readTokenAllowance(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("ALLOWANCE_READ_FAILED");
  });

  it("maps an untyped Wasm trap to ALLOWANCE_UNSUPPORTED_TOKEN", async () => {
    mockSimulate.mockResolvedValue({
      ok: false,
      reason: "contract_error",
      message: "HostError: Error(WasmVm, InvalidAction)",
      panic: { code: "CONTRACT_TRAPPED", title: "t", message: "m", remediation: "r", retryable: false },
    } as never);

    const outcome = await readTokenAllowance(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("ALLOWANCE_UNSUPPORTED_TOKEN");
  });

  it("keeps the decoded panic for a typed contract error", async () => {
    const panic = {
      code: "CONTRACT_ERROR" as const,
      contractCode: 7,
      errorName: "SomeTokenError",
      title: "Token error",
      message: "the token rejected the read",
      remediation: "retry",
      retryable: false,
    };
    mockSimulate.mockResolvedValue({
      ok: false,
      reason: "contract_error",
      message: "HostError: Error(Contract, #7)",
      panic,
    } as never);

    const outcome = await readTokenAllowance(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("ALLOWANCE_READ_FAILED");
    expect(outcome.error.panic).toEqual(panic);
  });

  it("treats a malformed allowance return value as a failed read", async () => {
    mockSimulate.mockResolvedValue({ ok: true, value: "not-a-number" });

    const outcome = await readTokenAllowance(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("ALLOWANCE_READ_FAILED");
  });

  it("never throws when the reader itself rejects", async () => {
    mockSimulate.mockRejectedValue(new Error("boom"));

    const outcome = await readTokenAllowance(request);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("ALLOWANCE_READ_FAILED");
  });
});

describe("mapAllowanceFailure determinism", () => {
  it("produces identical results for identical input", () => {
    const input = { kind: "insufficient_allowance" as const, required: 10n, available: 2n };
    expect(mapAllowanceFailure(input)).toEqual(mapAllowanceFailure(input));
  });
});
