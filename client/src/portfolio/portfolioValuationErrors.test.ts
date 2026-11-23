import { describe, it, expect } from "vitest";
import {
  describeValuationFailure,
  PortfolioValuationError,
} from "./portfolioValuationErrors";

describe("portfolioValuationErrors (#1660)", () => {
  it("normalizes rate limit / 429 errors into RATE_LIMITED without raw stack trace", () => {
    const error = new Error("Request failed with status code 429: Too Many Requests from Coingecko API");
    const failure = describeValuationFailure(error);

    expect(failure.code).toBe("RATE_LIMITED");
    expect(failure.message).toBe(
      "Valuation provider rate limit reached. Please wait a moment before refreshing.",
    );
    expect(failure.retryable).toBe(true);
    expect(failure.message).not.toContain("429");
    expect(failure.message).not.toContain("Coingecko");
  });

  it("normalizes network drop errors into NETWORK_ERROR", () => {
    const error = new TypeError("Failed to fetch");
    const failure = describeValuationFailure(error);

    expect(failure.code).toBe("NETWORK_ERROR");
    expect(failure.message).toBe(
      "Network connectivity lost. Retaining active portfolio view.",
    );
    expect(failure.retryable).toBe(true);
  });

  it("normalizes oracle / price feed errors into PRICE_FEED_UNAVAILABLE", () => {
    const error = new Error("Oracle price quote timed out on chain");
    const failure = describeValuationFailure(error);

    expect(failure.code).toBe("PRICE_FEED_UNAVAILABLE");
    expect(failure.message).toBe(
      "Price feeds are currently offline or unreachable. Displaying cached valuations.",
    );
    expect(failure.retryable).toBe(true);
  });

  it("normalizes unknown generic errors into VALUATION_REFRESH_FAILED", () => {
    const failure = describeValuationFailure("unknown unexpected string");

    expect(failure.code).toBe("VALUATION_REFRESH_FAILED");
    expect(failure.message).toBe(
      "Unable to refresh portfolio valuations. Displaying last known positions.",
    );
    expect(failure.retryable).toBe(true);
  });

  // ── Duplicate submission protection error codes (#1864) ──────────────────

  it("classifies duplicate submission errors into DUPLICATE_VALUATION_SUBMISSION", () => {
    const error = new Error("Duplicate: this valuation was already submitted.");
    const failure = describeValuationFailure(error);

    expect(failure.code).toBe("DUPLICATE_VALUATION_SUBMISSION");
    expect(failure.message).toBe(
      "This valuation request was already submitted. Showing previous result.",
    );
    expect(failure.retryable).toBe(true);
  });

  it("classifies in-progress errors into VALUATION_IN_PROGRESS", () => {
    const error = new Error("Valuation operation is already in progress.");
    const failure = describeValuationFailure(error);

    expect(failure.code).toBe("VALUATION_IN_PROGRESS");
    expect(failure.message).toBe(
      "A valuation is already in progress. Please wait before retrying.",
    );
    expect(failure.retryable).toBe(true);
  });

  it("classifies identity conflict errors into VALUATION_IDENTITY_CONFLICT", () => {
    const error = new Error("Operation identity conflict: parameters do not match initial submission.");
    const failure = describeValuationFailure(error);

    expect(failure.code).toBe("VALUATION_IDENTITY_CONFLICT");
    expect(failure.message).toBe(
      "Operation identity conflict: the submitted parameters do not match the original submission.",
    );
    expect(failure.retryable).toBe(true);
  });

  it("classifies network or ledger transitions into VALUATION_CONTEXT_MISMATCH", () => {
    const failure = describeValuationFailure(
      new Error("Valuation context does not match the active network and ledger."),
    );

    expect(failure.code).toBe("VALUATION_CONTEXT_MISMATCH");
    expect(failure.message).toBe(
      "The portfolio network or ledger changed. Refresh the portfolio before retrying.",
    );
    expect(failure.retryable).toBe(true);
  });

  it("preserves pre-typed PortfolioValuationError instances", () => {
    const typed = new PortfolioValuationError({
      code: "RATE_LIMITED",
      message: "Custom rate limit message",
      retryable: true,
      timestamp: "2026-10-18T12:00:00.000Z",
    });
    const failure = describeValuationFailure(typed);

    expect(failure.code).toBe("RATE_LIMITED");
    expect(failure.message).toBe("Custom rate limit message");
    expect(failure.timestamp).toBe("2026-10-18T12:00:00.000Z");
  });
});
