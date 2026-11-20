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
