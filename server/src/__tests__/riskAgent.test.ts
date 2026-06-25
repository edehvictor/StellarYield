import { assessProtocolRisk, ProtocolInput } from "../agents/riskAgent";
import { describe, it, expect, vi, afterEach } from "vitest";

// Mock fetch to simulate LLM responses
global.fetch = vi.fn();

describe("riskAgent fallback behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const dummyInput: ProtocolInput = {
    name: "Test Protocol",
    tvlUsd: 10_000_000,
    ageMonths: 12,
    audited: true,
  };

  it("falls back gracefully when JSON is malformed", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "{ malformed json: true " }] } }],
      }),
    });

    const report = await assessProtocolRisk(dummyInput);
    expect(report.score).toBeGreaterThan(0);
    expect(report.reasoning).toContain("Algorithmic assessment");
  });

  it("falls back when required fields are missing in JSON", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ score: 90 }) }] } }],
      }),
    });

    const report = await assessProtocolRisk(dummyInput);
    expect(report.reasoning).toContain("Algorithmic assessment");
  });

  it("falls back when LLM returns empty choices (OpenAI)", async () => {
    process.env.LLM_PROVIDER = "openai";
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ choices: [] }),
    });

    const report = await assessProtocolRisk(dummyInput);
    expect(report.reasoning).toContain("Algorithmic assessment");
    process.env.LLM_PROVIDER = "gemini"; // restore
  });

  it("falls back when LLM returns missing candidates (Gemini)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ candidates: [] }),
    });

    const report = await assessProtocolRisk(dummyInput);
    expect(report.reasoning).toContain("Algorithmic assessment");
  });
});
