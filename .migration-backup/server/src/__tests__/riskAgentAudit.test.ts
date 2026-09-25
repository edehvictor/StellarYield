import { assessProtocolRisk, type ProtocolInput } from "../agents/riskAgent";

const originalFetch = global.fetch;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalEnv = { ...process.env };

describe("Risk Agent Audit Logging Tests", () => {
  let logOutput: string[] = [];
  let errorOutput: string[] = [];

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    logOutput = [];
    errorOutput = [];

    // Mock console.log/console.error to capture audit records
    console.log = jest.fn().mockImplementation((msg) => {
      logOutput.push(msg);
    });
    console.error = jest.fn().mockImplementation((msg) => {
      errorOutput.push(msg);
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.env = { ...originalEnv };
  });

  const baseInput: ProtocolInput = {
    name: "AuditTestProtocol",
    tvlUsd: 1_000_000,
    ageMonths: 12,
    audited: true,
    recentNews: ["Everything is working perfectly."],
    governanceActivity: "Active DAO voting.",
  };

  it("emits structured audit metadata on successful Gemini API calls", async () => {
    process.env.GEMINI_API_KEY = "super-secret-gemini-key-12345";
    process.env.LLM_PROVIDER = "gemini";

    const mockResponseText = JSON.stringify({
      score: 80,
      category: "low",
      reasoning: "Test reasoning.",
      factors: { smartContractRisk: 80, governanceRisk: 80, marketRisk: 80, sentimentScore: 80 },
    });

    global.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: mockResponseText }] } }],
        }),
      } as any)
    );

    await assessProtocolRisk(baseInput);

    expect(logOutput.length).toBe(1);
    const logObj = JSON.parse(logOutput[0]);

    expect(logObj).toHaveProperty("ts");
    expect(logObj.level).toBe("info");
    expect(logObj.event).toBe("risk_agent_llm_call");
    expect(logObj.provider).toBe("gemini");
    expect(logObj.model).toBe("gemini-2.0-flash");
    expect(logObj.success).toBe(true);
    expect(typeof logObj.durationMs).toBe("number");
    expect(logObj.prompt).toContain("AuditTestProtocol");
    expect(logObj.response).toContain("Test reasoning");

    // Redaction check: the secret api key must NOT be in the log output
    expect(logOutput[0]).not.toContain("super-secret-gemini-key-12345");
  });

  it("redacts credentials from prompt and responses", async () => {
    process.env.OPENAI_API_KEY = "sk-proj-secret-openai-key-54321";
    process.env.LLM_PROVIDER = "openai";

    const mockResponseText = JSON.stringify({
      score: 50,
      category: "medium",
      reasoning: "Reasoning containing sensitiveBearer sk-proj-secret-openai-key-54321 token.",
      factors: { smartContractRisk: 50, governanceRisk: 50, marketRisk: 50, sentimentScore: 50 },
    });

    global.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: mockResponseText } }],
        }),
      } as any)
    );

    // Add a credential to the input prompt
    const inputWithSecret: ProtocolInput = {
      ...baseInput,
      recentNews: ["Leak of key=sk-proj-secret-openai-key-54321 reported."],
    };

    await assessProtocolRisk(inputWithSecret);

    expect(logOutput.length).toBe(1);
    const rawLog = logOutput[0];

    // Ensure the key is redacted
    expect(rawLog).not.toContain("sk-proj-secret-openai-key-54321");
    // Ensure generic pattern catches Bearer/key/apikey/api_key etc.
    expect(rawLog).toContain("key=[REDACTED]");
  });

  it("truncates prompt and response if they exceed 4000 characters", async () => {
    process.env.GEMINI_API_KEY = "mock-key";
    process.env.LLM_PROVIDER = "gemini";

    // Generate very long strings
    const longString = "A".repeat(4500);

    const mockResponseText = JSON.stringify({
      score: 90,
      category: "low",
      reasoning: longString,
      factors: { smartContractRisk: 90, governanceRisk: 90, marketRisk: 90, sentimentScore: 90 },
    });

    global.fetch = jest.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: mockResponseText }] } }],
        }),
      } as any)
    );

    const inputWithLongPrompt: ProtocolInput = {
      ...baseInput,
      recentNews: [longString],
    };

    await assessProtocolRisk(inputWithLongPrompt);

    expect(logOutput.length).toBe(1);
    const logObj = JSON.parse(logOutput[0]);

    expect(logObj.prompt.length).toBeLessThanOrEqual(4025); // 4000 + length of truncation notice
    expect(logObj.prompt).toContain("[TRUNCATED]");

    expect(logObj.response.length).toBeLessThanOrEqual(4025);
    expect(logObj.response).toContain("[TRUNCATED]");
  });

  it("emits structured audit metadata on failure", async () => {
    process.env.GEMINI_API_KEY = "mock-key";
    process.env.LLM_PROVIDER = "gemini";

    global.fetch = jest.fn().mockImplementation(() =>
      Promise.reject(new Error("Network Error"))
    );

    // Call assessProtocolRisk, which will log a failure but return fallback assessment
    const report = await assessProtocolRisk(baseInput);

    expect(errorOutput.length).toBe(1);
    const logObj = JSON.parse(errorOutput[0]);

    expect(logObj.level).toBe("error");
    expect(logObj.success).toBe(false);
    expect(logObj.error).toBe("Network Error");
    expect(logObj.provider).toBe("gemini");
    expect(logObj.model).toBe("gemini-2.0-flash");
    expect(report.protocol).toBe(baseInput.name);
  });
});
