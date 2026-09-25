import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/ApiClient";
import { ApiHttpError, ApiNetworkError, ApiTimeoutError } from "../src/errors";

describe("ApiClient retry policy (#955)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockFetchSequence(responses: Array<() => Promise<Response> | Response>) {
    let i = 0;
    const fetchMock = vi.fn(async () => {
      const next = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return next();
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("retries idempotent GET on retryable HTTP status with exponential backoff", async () => {
    const fetchMock = mockFetchSequence([
      () => new Response("fail", { status: 503, statusText: "Service Unavailable" }),
      () => new Response("fail", { status: 503, statusText: "Service Unavailable" }),
      () =>
        new Response(JSON.stringify([{ protocol: "vault-a", apy: 12 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);

    const client = new ApiClient({
      baseUrl: "https://api.test",
      maxRetries: 2,
      retryDelayMs: 100,
      retryableStatuses: [503],
    });

    const promise = client.getYields();
    await vi.runAllTimersAsync();
    const yields = await promise;

    expect(yields[0]?.apy).toBe(12);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-idempotent POST unless retrySafe", async () => {
    const fetchMock = mockFetchSequence([
      () => new Response("fail", { status: 503, statusText: "Service Unavailable" }),
      () =>
        new Response(JSON.stringify({ amount: "1", txHash: "abc" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);

    const client = new ApiClient({
      baseUrl: "https://api.test",
      maxRetries: 2,
      retryDelayMs: 50,
      retryableStatuses: [503],
    });

    await expect(client.claimReferral("GABC")).rejects.toBeInstanceOf(ApiHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries POST when marked retrySafe (zap quote)", async () => {
    const fetchMock = mockFetchSequence([
      () => new Response("fail", { status: 502, statusText: "Bad Gateway" }),
      () =>
        new Response(JSON.stringify({ amountOut: "100" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);

    const client = new ApiClient({
      baseUrl: "https://api.test",
      maxRetries: 1,
      retryDelayMs: 10,
      retryableStatuses: [502],
    });

    const promise = client.getZapQuote("XLM", "USDC", "1000");
    await vi.runAllTimersAsync();
    const quote = await promise;

    expect(quote.amountOut).toBe("100");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes abort/timeout into ApiTimeoutError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      })
    );

    const client = new ApiClient({
      baseUrl: "https://api.test",
      timeoutMs: 25,
      maxRetries: 0,
    });

    const promise = client.getHealth();
    const expectation = expect(promise).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(30);
    await expectation;
  });

  it("normalizes network failures into ApiNetworkError and retries", async () => {
    const fetchMock = mockFetchSequence([
      () => Promise.reject(new TypeError("fetch failed")),
      () =>
        new Response(JSON.stringify({ database: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);

    const client = new ApiClient({
      baseUrl: "https://api.test",
      maxRetries: 1,
      retryDelayMs: 5,
    });

    const promise = client.getHealth();
    await vi.runAllTimersAsync();
    const health = await promise;

    expect(health.database).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable 4xx responses", async () => {
    const fetchMock = mockFetchSequence([
      () => new Response("nope", { status: 404, statusText: "Not Found" }),
    ]);

    const client = new ApiClient({
      baseUrl: "https://api.test",
      maxRetries: 3,
      retryDelayMs: 10,
    });

    await expect(client.getYields()).rejects.toMatchObject({
      status: 404,
      retryable: false,
    } satisfies Partial<ApiHttpError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and surfaces ApiNetworkError", async () => {
    const fetchMock = mockFetchSequence([
      () => Promise.reject(new TypeError("network down")),
      () => Promise.reject(new TypeError("network down")),
      () => Promise.reject(new TypeError("network down")),
    ]);

    const client = new ApiClient({
      baseUrl: "https://api.test",
      maxRetries: 2,
      retryDelayMs: 1,
    });

    const promise = client.getYields();
    const expectation = expect(promise).rejects.toBeInstanceOf(ApiNetworkError);
    await vi.runAllTimersAsync();
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
