import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  describeZapQuoteVerifyFailure,
  fetchSwapQuote,
  isExpiredQuoteError,
  isQuoteCancellation,
  QuoteRequestCancelledError,
  verifySwapQuote,
  ZapQuoteError,
} from "./fetchSwapQuote";

const quoteRequest = {
  inputTokenContract: "A",
  vaultTokenContract: "B",
  amountInStroops: "1",
  inputDecimals: 7,
  vaultDecimals: 7,
};

describe("fetchSwapQuote", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            path: [{ contractId: "A" }],
            expectedAmountOutStroops: "100",
            source: "fallback_rate",
          }),
        } as Response),
      ),
    );
  });

  afterEach(() => {
    vi.stubGlobal("fetch", origFetch);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns parsed quote JSON", async () => {
    const q = await fetchSwapQuote({
      inputTokenContract: "A",
      vaultTokenContract: "B",
      amountInStroops: "1000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });
    expect(q.expectedAmountOutStroops).toBe("100");
    expect(q.source).toBe("fallback_rate");
  });

  it("throws when response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: async () => "server error",
        } as Response),
      ),
    );
    await expect(
      fetchSwapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1",
        inputDecimals: 7,
        vaultDecimals: 7,
      }),
    ).rejects.toThrow("server error");
  });

  it("preserves the typed server error for recoverable failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({
            error: "QUOTE_FAILED",
            message: "Router simulation unavailable.",
            requestId: "req-1",
            recoverable: true,
          }),
        } as Response),
      ),
    );

    const err = await fetchSwapQuote(quoteRequest).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ZapQuoteError);
    expect(err).toMatchObject({
      name: "ZapQuoteError",
      message: "Router simulation unavailable.",
      code: "QUOTE_FAILED",
      status: 500,
      requestId: "req-1",
      recoverable: true,
    });
  });

  it("marks validation failures as non-recoverable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            error: "INVALID_AMOUNT",
            message: "amountInStroops must be an integer string.",
          }),
        } as Response),
      ),
    );

    const err = await fetchSwapQuote(quoteRequest).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ZapQuoteError);
    expect(err).toMatchObject({
      message: "amountInStroops must be an integer string.",
      code: "INVALID_AMOUNT",
      status: 400,
      recoverable: false,
    });
  });

  it("wraps network-level failures as recoverable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("Network error"))),
    );

    const err = await fetchSwapQuote(quoteRequest).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ZapQuoteError);
    expect(err).toMatchObject({
      name: "ZapQuoteError",
      message: "Network error",
      code: "NETWORK_ERROR",
      status: 0,
      recoverable: true,
    });
  });

  it("uses VITE_API_BASE_URL when set", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://127.0.0.1:9999");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        path: [],
        expectedAmountOutStroops: "1",
        source: "fallback_rate" as const,
      }),
    } as Response);

    await fetchSwapQuote({
      inputTokenContract: "A",
      vaultTokenContract: "A",
      amountInStroops: "1",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    expect(spy).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/api/zap/quote",
      expect.any(Object),
    );
    spy.mockRestore();
  });

  it("uses status in error when body is empty on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 502,
          text: async () => "",
        } as Response),
      ),
    );
    await expect(
      fetchSwapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1",
        inputDecimals: 7,
        vaultDecimals: 7,
      }),
    ).rejects.toThrow("Quote failed (502)");
  });

  it("throws QuoteRequestCancelledError when aborted before response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
      }),
    );

    const controller = new AbortController();
    const promise = fetchSwapQuote(
      {
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1",
        inputDecimals: 7,
        vaultDecimals: 7,
      },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(QuoteRequestCancelledError);
    expect(isQuoteCancellation(await promise.catch((e) => e))).toBe(true);
  });

  it("rejects immediately when signal is already aborted", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchSwapQuote(
        {
          inputTokenContract: "A",
          vaultTokenContract: "B",
          amountInStroops: "1",
          inputDecimals: 7,
          vaultDecimals: 7,
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(QuoteRequestCancelledError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("verifySwapQuote", () => {
  const origFetch = globalThis.fetch;
  const validQuote = {
    path: [{ contractId: "A" }],
    expectedAmountOutStroops: "100",
    source: "fallback_rate" as const,
    slippageApplied: 0.005,
    amountOutAfterSlippage: "99",
    quotedAt: new Date().toISOString(),
    minAmountOutStroops: "99",
    quoteAgeMs: 0,
    isFallback: true,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    routeHash: "abc",
    assetConfigVersion: "def",
  };

  afterEach(() => {
    vi.stubGlobal("fetch", origFetch);
    vi.unstubAllGlobals();
  });

  it("returns true when the server reports success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({ ok: true, json: async () => ({ success: true }) } as Response),
      ),
    );
    await expect(verifySwapQuote(validQuote)).resolves.toBe(true);
  });

  it("throws a typed ZapQuoteError with the server's STALE_QUOTE code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            error: "STALE_QUOTE",
            message: "Quote has expired",
            recoverable: true,
          }),
        } as Response),
      ),
    );

    const err = await verifySwapQuote(validQuote).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZapQuoteError);
    expect(err).toMatchObject({
      code: "STALE_QUOTE",
      status: 400,
      recoverable: true,
    });
    expect(isExpiredQuoteError(err)).toBe(true);
  });

  it("wraps network failures as recoverable NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );

    const err = await verifySwapQuote(validQuote).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZapQuoteError);
    expect(err).toMatchObject({ code: "NETWORK_ERROR", status: 0, recoverable: true });
    expect(isExpiredQuoteError(err)).toBe(false);
  });
});

describe("describeZapQuoteVerifyFailure", () => {
  function codeError(code: string, message: string): ZapQuoteError {
    return new ZapQuoteError(message, { code, status: 400 });
  }

  it("maps STALE_QUOTE to the deterministic expiry message", () => {
    expect(
      describeZapQuoteVerifyFailure(codeError("STALE_QUOTE", "provider said something else")),
    ).toBe("Quote expired. Refresh and try again.");
  });

  it("maps CONFIG_DRIFT deterministically", () => {
    expect(describeZapQuoteVerifyFailure(codeError("CONFIG_DRIFT", "x"))).toBe(
      "Supported assets changed. Refresh and try again.",
    );
  });

  it("falls back to a generic message for unknown codes without echoing the server text", () => {
    const message = describeZapQuoteVerifyFailure(
      codeError("SOME_NEW_CODE", "raw provider gibberish"),
    );
    expect(message).toBe("Quote validation failed. Refresh and try again.");
    expect(message).not.toContain("raw provider gibberish");
  });
});
