import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApyConfidencePanel, normalizeExplanation } from "../ApyConfidencePanel";

const mockFetch = vi.fn();
global.fetch = mockFetch;

function explanationPayload(overrides = {}) {
  return {
    protocol: "Blend",
    level: "high",
    confidence: 0.8,
    forecastApy: 6.5,
    quorumMet: true,
    summary: "APY confidence is high for Blend with 3 of 3 sources in agreement.",
    sources: [
      { provider: "YieldWatch", apy: 6.8, status: "fresh", isValid: true, detail: "YieldWatch reports 6.80% and counts toward the APY consensus." },
      { provider: "DeFiLlama", apy: 6.5, status: "fresh", isValid: true, detail: "DeFiLlama reports 6.50% and counts toward the APY consensus." },
    ],
    factors: [
      { key: "source-quorum", label: "Source quorum", value: "2/2 valid", impact: "positive", detail: "2 of 2 sources are fresh and valid." },
    ],
    ...overrides,
  };
}

describe("ApyConfidencePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders sources and factors on the main path", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ explanation: explanationPayload() }),
    });

    render(<ApyConfidencePanel protocol="Blend" />);
    expect(await screen.findByText("APY Confidence")).toBeInTheDocument();
    expect(screen.getByText("DeFiLlama")).toBeInTheDocument();
    expect(screen.getByText("YieldWatch")).toBeInTheDocument();
    expect(screen.getByText("Source quorum")).toBeInTheDocument();
    expect(
      screen.getByText("APY confidence is high for Blend with 3 of 3 sources in agreement."),
    ).toBeInTheDocument();
  });

  it("edge (a): quorum-not-met payload renders low state with fallback copy", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        explanation: explanationPayload({
          level: "low",
          quorumMet: false,
          sources: [],
          summary: "APY confidence is low for Blend: quorum is not met (0 of 0 sources valid). Treat the forecast as indicative only.",
        }),
      }),
    });

    render(<ApyConfidencePanel protocol="Blend" />);
    expect(await screen.findByText("Low confidence")).toBeInTheDocument();
    expect(screen.getByText(/quorum is not met/)).toBeInTheDocument();
  });

  it("edge (b): stale and failing sources render with stable fallback details", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        explanation: explanationPayload({
          level: "reduced",
          summary: "APY confidence is reduced for Blend: 1 stale source.",
          sources: [
            { provider: "StaleFeed", apy: 6.1, status: "stale", isValid: false, detail: "StaleFeed reported 6.10% but the reading is stale, so it is excluded from the APY consensus." },
            { provider: "DeadFeed", apy: null, status: "failing", isValid: false, detail: "DeadFeed is failing and excluded from the APY consensus (reported no APY)." },
          ],
        }),
      }),
    });

    render(<ApyConfidencePanel protocol="Blend" />);
    expect(await screen.findByText("Reduced confidence")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText("Failing")).toBeInTheDocument();
  });

  it("renders an empty state when the backend has no explanation", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    render(<ApyConfidencePanel protocol="Blend" />);
    expect(await screen.findByText(/No confidence explanation available/)).toBeInTheDocument();
  });

  it("renders a stable error with retry on fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    render(<ApyConfidencePanel protocol="Blend" />);
    expect(await screen.findByText("Network error")).toBeInTheDocument();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ explanation: explanationPayload() }),
    });
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("DeFiLlama")).toBeInTheDocument();
  });

  it("normalizeExplanation sorts nothing and never throws on garbage", () => {
    expect(normalizeExplanation(null)).toBeNull();
    expect(normalizeExplanation({})).toBeNull();
    expect(normalizeExplanation({ summary: 42 })).toBeNull();
    const normalized = normalizeExplanation({
      summary: "hi",
      level: "bogus",
      sources: [{ provider: null, apy: "x", status: "bogus" }],
      factors: "nope",
    });
    expect(normalized?.level).toBe("unknown");
    expect(normalized?.sources[0].provider).toBe("unknown-provider");
    expect(normalized?.sources[0].status).toBe("unknown");
    expect(normalized?.factors).toEqual([]);
  });
});
