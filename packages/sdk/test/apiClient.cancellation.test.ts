import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/ApiClient";
import { ApiCancelledError, ApiTimeoutError, isApiCancellation } from "../src/errors";

describe("ApiClient request cancellation (#1047)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function hangingFetch() {
    return vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true }
        );
      });
    });
  }

  it("cancels getZapQuote before response and returns ApiCancelledError", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({
      baseUrl: "https://api.test",
      timeoutMs: 30_000,
      maxRetries: 0,
    });
    const controller = new AbortController();

    const promise = client.getZapQuote("XLM", "USDC", "1000", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(ApiCancelledError);
    await expect(promise).rejects.toMatchObject({
      cancelled: true,
      path: "/api/zap/quote",
      retryable: false,
    });
    expect(isApiCancellation(await promise.catch((e) => e))).toBe(true);
  });

  it("cancels simulateDeposit before response and returns ApiCancelledError", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    const client = new ApiClient({
      baseUrl: "https://api.test",
      timeoutMs: 30_000,
      maxRetries: 2,
    });
    const controller = new AbortController();

    const promise = client.simulateDeposit(
      { strategyId: "s1", amount: 100, token: "USDC" },
      { signal: controller.signal }
    );
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(ApiCancelledError);
    expect(isApiCancellation(await promise.catch((e) => e))).toBe(true);
  });

  it("rejects immediately when signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "https://api.test", maxRetries: 0 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.getZapQuote("XLM", "USDC", "1", { signal: controller.signal })
    ).rejects.toBeInstanceOf(ApiCancelledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry after caller cancellation", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({
      baseUrl: "https://api.test",
      timeoutMs: 30_000,
      maxRetries: 3,
      retryDelayMs: 1,
    });
    const controller = new AbortController();

    const promise = client.getZapQuote("XLM", "USDC", "5", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ApiCancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still maps timeout aborts to ApiTimeoutError (not cancellation)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());

    const client = new ApiClient({
      baseUrl: "https://api.test",
      timeoutMs: 40,
      maxRetries: 0,
    });

    const promise = client.getZapQuote("XLM", "USDC", "1");
    const expectation = expect(promise).rejects.toBeInstanceOf(ApiTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await expectation;
  });

  it("ignores late quote responses after rapid abort (stale guard)", async () => {
    let resolveSecond: ((value: Response) => void) | undefined;
    let call = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        call += 1;
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });

          if (call === 1) {
            // First request stays pending until aborted by the caller.
            return;
          }
          resolveSecond = resolve;
        });
      })
    );

    const client = new ApiClient({
      baseUrl: "https://api.test",
      timeoutMs: 30_000,
      maxRetries: 0,
    });

    const firstController = new AbortController();
    const first = client.getZapQuote("XLM", "USDC", "100", {
      signal: firstController.signal,
    });
    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(ApiCancelledError);

    const secondController = new AbortController();
    const secondPromise = client.getZapQuote("XLM", "USDC", "200", {
      signal: secondController.signal,
    });

    // Wait briefly for the second fetch to register its resolver.
    await Promise.resolve();
    resolveSecond?.(
      new Response(JSON.stringify({ amountOut: "200" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const second = await secondPromise;
    expect(second.amountOut).toBe("200");
    expect(call).toBe(2);
  });
});
