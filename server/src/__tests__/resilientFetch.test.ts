import {
  resilientFetch,
  getCircuitBreaker,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_RESET_MS,
} from "../agents/resilientFetch";

const CIRCUIT_KEY = "test-provider";

beforeEach(() => {
  resetAllCircuitBreakers();
  jest.restoreAllMocks();
});

describe("resilientFetch", () => {
  describe("timeout handling", () => {
    it("aborts request after timeout", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal as AbortSignal;
            if (signal) {
              signal.addEventListener("abort", () => {
                reject(new Error("The operation was aborted"));
              });
            }
          }),
      );

      await expect(
        resilientFetch("https://example.com", { method: "GET" }, CIRCUIT_KEY, {
          timeoutMs: 50,
          maxRetries: 0,
        }),
      ).rejects.toThrow();

      global.fetch = originalFetch;
    });

    it("succeeds when response arrives before timeout", async () => {
      const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const res = await resilientFetch(
        "https://example.com",
        { method: "GET" },
        CIRCUIT_KEY,
        { timeoutMs: 5000, maxRetries: 0 },
      );

      expect(res.status).toBe(200);
      global.fetch = jest.fn();
    });
  });

  describe("retry behavior", () => {
    it("retries on transient failure and succeeds", async () => {
      const mockResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("fetch failed"));
        }
        return Promise.resolve(mockResponse);
      });

      const res = await resilientFetch(
        "https://example.com",
        { method: "POST" },
        CIRCUIT_KEY,
        { timeoutMs: 5000, maxRetries: 2, initialDelayMs: 10, maxDelayMs: 50 },
      );

      expect(res.status).toBe(200);
      expect(callCount).toBe(2);
    });

    it("exhausts retries and throws", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("fetch failed"));

      await expect(
        resilientFetch("https://example.com", { method: "GET" }, CIRCUIT_KEY, {
          timeoutMs: 5000,
          maxRetries: 2,
          initialDelayMs: 10,
          maxDelayMs: 50,
        }),
      ).rejects.toThrow("fetch failed");

      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it("does not retry on non-retryable errors", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("Invalid JSON"));

      await expect(
        resilientFetch("https://example.com", { method: "GET" }, CIRCUIT_KEY, {
          timeoutMs: 5000,
          maxRetries: 2,
          initialDelayMs: 10,
        }),
      ).rejects.toThrow("Invalid JSON");

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("retries on server 500 errors", async () => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(new Response("", { status: 500 }));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      });

      const res = await resilientFetch(
        "https://example.com",
        { method: "GET" },
        CIRCUIT_KEY,
        { timeoutMs: 5000, maxRetries: 2, initialDelayMs: 10, maxDelayMs: 50 },
      );

      expect(res.status).toBe(200);
      expect(callCount).toBe(3);
    });
  });

  describe("circuit breaker", () => {
    it("opens after consecutive failures reach threshold", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("fetch failed"));

      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        await resilientFetch(
          "https://example.com",
          { method: "GET" },
          CIRCUIT_KEY,
          { timeoutMs: 5000, maxRetries: 0, initialDelayMs: 10 },
        ).catch(() => {});
      }

      const cb = getCircuitBreaker(CIRCUIT_KEY);
      expect(cb.isOpen).toBe(true);
      expect(cb.failures).toBe(CIRCUIT_BREAKER_THRESHOLD);
    });

    it("rejects immediately when circuit is open", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("fetch failed"));

      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        await resilientFetch(
          "https://example.com",
          { method: "GET" },
          CIRCUIT_KEY,
          { timeoutMs: 5000, maxRetries: 0, initialDelayMs: 10 },
        ).catch(() => {});
      }

      (global.fetch as jest.Mock).mockClear();

      await expect(
        resilientFetch("https://example.com", { method: "GET" }, CIRCUIT_KEY, {
          timeoutMs: 5000,
          maxRetries: 0,
        }),
      ).rejects.toThrow("Circuit breaker open");

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("resets after successful call", async () => {
      const cb = getCircuitBreaker(CIRCUIT_KEY);
      cb.failures = 3;

      global.fetch = jest
        .fn()
        .mockResolvedValue(new Response("{}", { status: 200 }));

      await resilientFetch(
        "https://example.com",
        { method: "GET" },
        CIRCUIT_KEY,
        { timeoutMs: 5000, maxRetries: 0 },
      );

      expect(getCircuitBreaker(CIRCUIT_KEY).failures).toBe(0);
    });

    it("can be manually reset", () => {
      const cb = getCircuitBreaker(CIRCUIT_KEY);
      cb.failures = CIRCUIT_BREAKER_THRESHOLD;
      cb.isOpen = true;

      resetCircuitBreaker(CIRCUIT_KEY);

      const reset = getCircuitBreaker(CIRCUIT_KEY);
      expect(reset.failures).toBe(0);
      expect(reset.isOpen).toBe(false);
    });

    it("half-opens after reset interval", async () => {
      const cb = getCircuitBreaker(CIRCUIT_KEY);
      cb.failures = CIRCUIT_BREAKER_THRESHOLD;
      cb.isOpen = true;
      cb.lastFailureTime = Date.now() - CIRCUIT_BREAKER_RESET_MS - 1;

      global.fetch = jest
        .fn()
        .mockResolvedValue(new Response("{}", { status: 200 }));

      const res = await resilientFetch(
        "https://example.com",
        { method: "GET" },
        CIRCUIT_KEY,
        { timeoutMs: 5000, maxRetries: 0 },
      );

      expect(res.status).toBe(200);
      expect(getCircuitBreaker(CIRCUIT_KEY).isOpen).toBe(false);
    });
  });

  describe("graceful degradation", () => {
    it("assessProtocolRisk falls back on circuit breaker open", async () => {
      const { assessProtocolRisk } = await import("../agents/riskAgent");

      resetCircuitBreaker("gemini-risk-agent");
      resetCircuitBreaker("openai-risk-agent");

      const report = await assessProtocolRisk({
        name: "TestProtocol",
        tvlUsd: 50_000_000,
        ageMonths: 24,
        audited: true,
      });

      expect(report.protocol).toBe("TestProtocol");
      expect(report.score).toBeGreaterThan(0);
      expect(report.score).toBeLessThanOrEqual(100);
      expect(["low", "medium", "high", "critical"]).toContain(report.category);
      expect(report.timestamp).toBeDefined();
    });
  });
});
