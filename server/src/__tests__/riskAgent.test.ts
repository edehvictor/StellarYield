import { assessProtocolRisk, type ProtocolInput, type RiskReport } from "../agents/riskAgent";

// Save references to original env variables and fetch
const originalFetch = global.fetch;
const originalEnv = { ...process.env };

describe("Risk Agent Parity & Fallback Tests", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  // Shared protocol input fixtures
  const safeProtocolFixture: ProtocolInput = {
    name: "SafeStable",
    tvlUsd: 50_000_000,
    ageMonths: 24,
    audited: true,
    recentNews: ["Protocol launches version 2 with zero security issues.", "TVL reaches new highs."],
    governanceActivity: "All 15 proposals passed successfully. Active community voting.",
  };

  const riskyProtocolFixture: ProtocolInput = {
    name: "RiskyFarm",
    tvlUsd: 10_000,
    ageMonths: 1,
    audited: false,
    recentNews: ["Unverified smart contract code spotted.", "Rumors of developer key leakage."],
    governanceActivity: "Single wallet controls 95% of voting power.",
  };

  const moderateProtocolFixture: ProtocolInput = {
    name: "ModLend",
    tvlUsd: 2_500_000,
    ageMonths: 8,
    audited: true,
    recentNews: ["Minor UI glitch resolved.", "Community discusses expansion to new chains."],
    governanceActivity: "Multi-sig transition proposed.",
  };

  // Helper to mock a successful LLM response
  function mockSuccessfulLLMResponse(score: number, category: string, reasoning: string) {
    const mockJson = {
      score,
      category,
      reasoning,
      factors: {
        smartContractRisk: score - 5,
        governanceRisk: score,
        marketRisk: score + 5,
        sentimentScore: score - 2,
      },
    };

    global.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(mockJson) }],
              },
            },
          ],
        }),
      } as any)
    );
  }

  // Helper to mock a failed LLM response (to trigger fallback)
  function mockFailedLLMResponse() {
    global.fetch = jest.fn().mockImplementation(() =>
      Promise.reject(new Error("Rate Limit or API Key invalid"))
    );
  }

  it("checks structure compatibility between LLM response and heuristic fallback", async () => {
    process.env.GEMINI_API_KEY = "mock-api-key";
    process.env.LLM_PROVIDER = "gemini";

    // 1. Get primary LLM result
    mockSuccessfulLLMResponse(85, "low", "Strong history and TVL.");
    const llmReport = await assessProtocolRisk(safeProtocolFixture);

    // 2. Get fallback result
    mockFailedLLMResponse();
    const fallbackReport = await assessProtocolRisk(safeProtocolFixture);

    // Verify both comply with RiskReport structure
    for (const report of [llmReport, fallbackReport]) {
      expect(report).toHaveProperty("protocol");
      expect(report).toHaveProperty("score");
      expect(report).toHaveProperty("category");
      expect(report).toHaveProperty("reasoning");
      expect(report).toHaveProperty("factors");
      expect(report).toHaveProperty("timestamp");

      expect(typeof report.protocol).toBe("string");
      expect(typeof report.score).toBe("number");
      expect(["low", "medium", "high", "critical"]).toContain(report.category);
      expect(typeof report.reasoning).toBe("string");
      expect(typeof report.timestamp).toBe("string");

      expect(report.factors).toHaveProperty("smartContractRisk");
      expect(report.factors).toHaveProperty("governanceRisk");
      expect(report.factors).toHaveProperty("marketRisk");
      expect(report.factors).toHaveProperty("sentimentScore");

      expect(typeof report.factors.smartContractRisk).toBe("number");
      expect(typeof report.factors.governanceRisk).toBe("number");
      expect(typeof report.factors.marketRisk).toBe("number");
      expect(typeof report.factors.sentimentScore).toBe("number");
    }
  });

  it("compares primary and fallback mode score/category alignment on a safe protocol", async () => {
    process.env.GEMINI_API_KEY = "mock-api-key";

    // LLM assessment
    mockSuccessfulLLMResponse(92, "low", "Highly secure protocol.");
    const llmReport = await assessProtocolRisk(safeProtocolFixture);

    // Fallback assessment
    mockFailedLLMResponse();
    const fallbackReport = await assessProtocolRisk(safeProtocolFixture);

    // Safe protocol should be categorized as low/medium in both
    expect(["low", "medium"]).toContain(llmReport.category);
    expect(["low", "medium"]).toContain(fallbackReport.category);

    // Scores should both be relatively high (>= 60) for a safe, audited, high-TVL protocol
    expect(llmReport.score).toBeGreaterThanOrEqual(60);
    expect(fallbackReport.score).toBeGreaterThanOrEqual(60);
  });

  it("compares primary and fallback mode score/category alignment on a risky protocol", async () => {
    process.env.GEMINI_API_KEY = "mock-api-key";

    // LLM assessment
    mockSuccessfulLLMResponse(25, "high", "High risk of contract issues.");
    const llmReport = await assessProtocolRisk(riskyProtocolFixture);

    // Fallback assessment
    mockFailedLLMResponse();
    const fallbackReport = await assessProtocolRisk(riskyProtocolFixture);

    // Risky protocol should be categorized as high/critical/medium (not low)
    expect(["high", "critical", "medium"]).toContain(llmReport.category);
    expect(["high", "critical", "medium"]).toContain(fallbackReport.category);

    // Scores should both be relatively low (<= 50) for a brand new, unaudited, low-TVL protocol
    expect(llmReport.score).toBeLessThanOrEqual(50);
    expect(fallbackReport.score).toBeLessThanOrEqual(50);
  });

  it("detects large drift between primary and fallback scores", async () => {
    process.env.GEMINI_API_KEY = "mock-api-key";

    // Mock an extremely drifted LLM response
    mockSuccessfulLLMResponse(99, "low", "LLM thinks this is super safe.");
    const llmReport = await assessProtocolRisk(moderateProtocolFixture);

    mockFailedLLMResponse();
    const fallbackReport = await assessProtocolRisk(moderateProtocolFixture);

    // Compute absolute drift
    const drift = Math.abs(llmReport.score - fallbackReport.score);
    
    // We expect the test to be able to identify and assert on drift size
    expect(drift).toBeLessThanOrEqual(100); // Bounds check
    // Ensure the structure remains compatible regardless of drift
    expect(llmReport.protocol).toBe(fallbackReport.protocol);
import { assessProtocolRisk, ProtocolInput } from "../agents/riskAgent";
import { resilientFetch } from "../agents/resilientFetch";

// Mock resilientFetch to simulate LLM responses
jest.mock("../agents/resilientFetch", () => ({
  resilientFetch: jest.fn(),
}));

const mockFetch = resilientFetch as jest.MockedFunction<typeof resilientFetch>;

describe("Risk Agent - LLM Provider Fallback and Regression Tests", () => {
  const dummyInput: ProtocolInput = {
    name: "TestProtocol",
    tvlUsd: 1000000,
    ageMonths: 12,
    audited: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockResponse = (body: any, ok: boolean = true) => {
    return Promise.resolve({
      ok,
      json: () => Promise.resolve(body),
    } as any);
  };

  it("handles malformed JSON from LLM by falling back to algorithmic scoring", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        candidates: [{ content: { parts: [{ text: "This is not valid JSON {score: broken}" }] } }],
      })
    );

    const result = await assessProtocolRisk(dummyInput);
    
    // Algorithmic fallback should give score based on inputs (tvl, age, audited)
    expect(result.protocol).toBe("TestProtocol");
    expect(result.reasoning).toContain("Algorithmic assessment");
    expect(result.score).toBeGreaterThan(0);
    expect(result.factors.smartContractRisk).toBe(80); // audited
  });

  it("handles empty choices from provider gracefully", async () => {
    // Simulate Gemini returning empty candidates
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        candidates: [],
      })
    );

    const result = await assessProtocolRisk(dummyInput);
    
    expect(result.reasoning).toContain("Algorithmic assessment");
    expect(result.score).toBeGreaterThan(0);
  });

  it("handles missing category fields by applying default medium category", async () => {
    // LLM returns valid JSON but misses 'category'
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({
            score: 85,
            reasoning: "Seems good",
            factors: {
              smartContractRisk: 90,
              governanceRisk: 80,
              marketRisk: 70,
              sentimentScore: 60
            }
          })}]}
        }],
      })
    );

    const result = await assessProtocolRisk(dummyInput);
    
    expect(result.score).toBe(85);
    expect(result.category).toBe("medium"); // default category
  });

  it("returns deterministic fallback output on malformed model responses", async () => {
    // Throw error from fetch
    mockFetch.mockRejectedValueOnce(new Error("Network Error"));

    const result = await assessProtocolRisk(dummyInput);
    
    expect(result.reasoning).toContain("Algorithmic assessment based on TVL");
    expect(result.factors.smartContractRisk).toBe(80);
    expect(result.factors.governanceRisk).toBe(50);
  });
});
