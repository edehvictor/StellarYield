import { describe, it, expect } from "vitest";
import {
  areTransactionReviewDiagnosticsPrivacySafe,
  buildExecutionDiagnostics,
  buildQuoteVerificationDiagnostics,
  buildTransactionReviewFailureDiagnostics,
  parseTransactionReviewDiagnostics,
} from "./transactionReviewDiagnostic";

describe("transactionReviewDiagnostic (#1893)", () => {
  it("names the failed stage and always states state was preserved", () => {
    const d = buildTransactionReviewFailureDiagnostics("STAGE_UNAVAILABLE", { stage: "quote" });
    expect(d[0]).toMatchObject({ stage: "quote", code: "STAGE_UNAVAILABLE", retryable: true });
    expect(d[1]).toMatchObject({ code: "STATE_PRESERVED", affectedStages: ["quote"] });
    expect(areTransactionReviewDiagnosticsPrivacySafe(d)).toBe(true);
  });

  it("maps verify codes to refresh vs validation, and unknown codes to insufficient context", () => {
    for (const code of ["STALE_QUOTE", "CONFIG_DRIFT", "ASSUMPTION_DRIFT", "INVALID_FINGERPRINT"]) {
      const diagnostics = buildQuoteVerificationDiagnostics(code);
      expect(diagnostics[0]).toMatchObject({
        code: "QUOTE_REFRESH_REQUIRED",
        stage: "quote-verification",
        retryable: true,
      });
      expect(diagnostics[1]).toMatchObject({
        code: "STATE_PRESERVED",
        affectedStages: ["quote-verification"],
      });
      expect(areTransactionReviewDiagnosticsPrivacySafe(diagnostics)).toBe(true);
    }

    expect(buildQuoteVerificationDiagnostics("SLIPPAGE_EXCEEDED")[0]).toMatchObject({
      code: "VALIDATION_FAILED",
      retryable: false,
    });
    expect(buildQuoteVerificationDiagnostics("SOMETHING_NEW")[0].code).toBe("CONTEXT_INSUFFICIENT");
  });

  it("marks failures at or after submission as retry-unsafe, earlier ones as safe", () => {
    expect(buildExecutionDiagnostics("signing")[0]).toMatchObject({ stage: "wallet-signing", retryable: true });
    expect(buildExecutionDiagnostics("submitting")[0]).toMatchObject({ code: "RETRY_UNSAFE", retryable: false });
    expect(buildExecutionDiagnostics("polling")[0]).toMatchObject({
      stage: "confirmation",
      code: "RETRY_UNSAFE",
      retryable: false,
    });
    expect(buildExecutionDiagnostics("idle")[0].stage).toBe("unknown");
  });

  it("parses untrusted diagnostics, dropping invalid entries and rebuilding text from templates", () => {
    const parsed = parseTransactionReviewDiagnostics([
      { code: "STAGE_UNAVAILABLE", stage: "quote", summary: "http://evil.example GABC leak" },
      { code: "NOPE", stage: "quote" },
      { code: "STATE_PRESERVED", stage: "bogus-stage" },
      null,
      "string",
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].summary).not.toContain("evil");
    expect(areTransactionReviewDiagnosticsPrivacySafe(parsed)).toBe(true);
    expect(parseTransactionReviewDiagnostics(undefined)).toEqual([]);
    expect(parseTransactionReviewDiagnostics({ code: "x" })).toEqual([]);
  });
});
