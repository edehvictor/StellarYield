import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSwapQuote, ZapQuoteError } from "./fetchSwapQuote";

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
});
