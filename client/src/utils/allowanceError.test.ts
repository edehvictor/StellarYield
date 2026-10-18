import { describe, it, expect } from "vitest";
import {
  describeAllowanceShortfall,
  isTokenAllowanceError,
  serializeAllowanceError,
  toDecodedError,
} from "./allowanceError";
import {
  evaluateAllowance,
  mapAllowanceFailure,
  tokenAllowanceErrorCodes,
} from "../../../shared/types/tokenAllowance";

describe("mapAllowanceFailure", () => {
  it("maps an insufficient allowance to a typed error with the shortfall", () => {
    const error = mapAllowanceFailure({
      kind: "insufficient_allowance",
      required: 1000n,
      available: 250n,
    });

    expect(error).toMatchObject({
      code: "INSUFFICIENT_ALLOWANCE",
      required: 1000n,
      available: 250n,
      shortfall: 750n,
      retryable: false,
    });
    expect(error.title).toBe("Token Allowance Too Low");
  });

  it("maps every structured failure kind to a stable code", () => {
    expect(mapAllowanceFailure({ kind: "read_failed" }).code).toBe("ALLOWANCE_READ_FAILED");
    expect(mapAllowanceFailure({ kind: "read_timeout" }).code).toBe("ALLOWANCE_READ_TIMEOUT");
    expect(mapAllowanceFailure({ kind: "unsupported_token" }).code).toBe(
      "ALLOWANCE_UNSUPPORTED_TOKEN",
    );
    expect(
      mapAllowanceFailure({ kind: "invalid_amount", reason: "non_positive" }).code,
    ).toBe("INVALID_ALLOWANCE_AMOUNT");
  });

  it("is deterministic for the same input", () => {
    const failure = { kind: "read_timeout" as const };
    expect(mapAllowanceFailure(failure)).toEqual(mapAllowanceFailure(failure));
  });

  it("catalogues exactly the declared error codes", () => {
    expect(new Set(tokenAllowanceErrorCodes())).toEqual(
      new Set([
        "INSUFFICIENT_ALLOWANCE",
        "ALLOWANCE_READ_FAILED",
        "ALLOWANCE_READ_TIMEOUT",
        "ALLOWANCE_UNSUPPORTED_TOKEN",
        "INVALID_ALLOWANCE_AMOUNT",
      ]),
    );
  });
});

describe("evaluateAllowance", () => {
  it("reports sufficiency and computes the shortfall", () => {
    expect(evaluateAllowance(1000n, 500n)).toEqual({ sufficient: true, shortfall: 0n });
    expect(evaluateAllowance(400n, 1000n)).toEqual({ sufficient: false, shortfall: 600n });
    expect(evaluateAllowance(1000n, 1000n)).toEqual({ sufficient: true, shortfall: 0n });
  });

  it("treats a non-positive requirement as satisfied", () => {
    expect(evaluateAllowance(0n, 0n).sufficient).toBe(true);
  });
});

describe("toDecodedError", () => {
  it("maps a typed allowance error into the transaction modal shape", () => {
    const decoded = toDecodedError(
      mapAllowanceFailure({ kind: "insufficient_allowance", required: 1000n, available: 250n }),
    );

    expect(decoded.title).toBe("Token Allowance Too Low");
    expect(decoded.message).toMatch(/more of this token/i);
    expect(decoded.suggestion).toContain("short by 750");
    expect(decoded.raw).toContain("code=INSUFFICIENT_ALLOWANCE");
    expect(decoded.raw).toContain("required=1000");
  });

  it("does not append a shortfall when amounts are unknown", () => {
    const decoded = toDecodedError(mapAllowanceFailure({ kind: "read_timeout" }));
    expect(decoded.suggestion).not.toContain("short by");
  });
});

describe("describeAllowanceShortfall", () => {
  it("returns null when the allowance is not short or amounts are missing", () => {
    expect(describeAllowanceShortfall(mapAllowanceFailure({ kind: "read_timeout" }))).toBeNull();
    expect(
      describeAllowanceShortfall({
        code: "INSUFFICIENT_ALLOWANCE",
        title: "t",
        message: "m",
        remediation: "r",
        retryable: false,
        required: 10n,
        available: 10n,
        shortfall: 0n,
      }),
    ).toBeNull();
  });

  it("describes the shortfall when present", () => {
    const described = describeAllowanceShortfall(
      mapAllowanceFailure({ kind: "insufficient_allowance", required: 10n, available: 4n }),
    );
    expect(described).toContain("Approved 4 of 10 required");
    expect(described).toContain("short by 6");
  });
});

describe("serializeAllowanceError / isTokenAllowanceError", () => {
  it("serializes without provider text and detects typed errors", () => {
    const error = mapAllowanceFailure({ kind: "read_timeout" });
    expect(serializeAllowanceError(error)).toContain("code=ALLOWANCE_READ_TIMEOUT");
    expect(isTokenAllowanceError(error)).toBe(true);
    expect(isTokenAllowanceError({ code: "OTHER" })).toBe(false);
    expect(isTokenAllowanceError(null)).toBe(false);
  });
});
