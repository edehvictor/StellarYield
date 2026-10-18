import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, createMemoryCacheStore } from "../src/api/ApiClient";
import { ApiNetworkError } from "../src/errors";

function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiClient.cachedGet offline cache (#1125)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns fresh data and writes it to the cache store", async () => {
    const store = createMemoryCacheStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson([{ protocol: "vault-a", apy: 12 }]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({ baseUrl: "https://api.test", cacheStore: store });
    const result = await client.cachedGet<Array<{ apy: number }>>("/api/yields");

    expect(result).toMatchObject({
      fromCache: false,
      offline: false,
      error: null,
    });
    expect(result.data?.[0]?.apy).toBe(12);
    expect(result.fetchedAt).toBeTypeOf("number");
    expect(await store.get("sy_api_get:/api/yields")).toMatchObject({
      data: [{ apy: 12 }],
    });
  });

  it("serves cached data when the network fails, then replaces it on reconnect", async () => {
    const store = createMemoryCacheStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson([{ protocol: "vault-a", apy: 12 }]))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okJson([{ protocol: "vault-a", apy: 15 }]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({
      baseUrl: "https://api.test",
      cacheStore: store,
      maxRetries: 0,
    });

    const first = await client.cachedGet<Array<{ apy: number }>>("/api/yields");
    expect(first.fromCache).toBe(false);
    expect(first.data?.[0]?.apy).toBe(12);

    const offline = await client.cachedGet<Array<{ apy: number }>>("/api/yields");
    expect(offline).toMatchObject({ fromCache: true, offline: true, error: null });
    expect(offline.data?.[0]?.apy).toBe(12);
    expect(offline.fetchedAt).toBe(first.fetchedAt);

    const reconnected = await client.cachedGet<Array<{ apy: number }>>("/api/yields");
    expect(reconnected).toMatchObject({ fromCache: false, offline: false });
    expect(reconnected.data?.[0]?.apy).toBe(15);

    const entry = await store.get("sy_api_get:/api/yields");
    expect(entry?.data).toMatchObject([{ apy: 15 }]);
  });

  it("reports an error when offline with no cached entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const client = new ApiClient({
      baseUrl: "https://api.test",
      cacheStore: createMemoryCacheStore(),
      maxRetries: 0,
    });

    const result = await client.cachedGet("/api/yields");

    expect(result.data).toBeNull();
    expect(result.fromCache).toBe(false);
    expect(result.offline).toBe(true);
    expect(result.error).toContain("fetch failed");
  });

  it("does not serve expired cache entries", async () => {
    const store = createMemoryCacheStore();
    store.set("sy_api_get:/api/yields", {
      data: [{ apy: 1 }],
      fetchedAt: Date.now() - 10_000,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const client = new ApiClient({
      baseUrl: "https://api.test",
      cacheStore: store,
      maxRetries: 0,
    });

    const result = await client.cachedGet("/api/yields", { maxAgeMs: 1_000 });

    expect(result.data).toBeNull();
    expect(result.error).toContain("fetch failed");
  });

  it("still throws ApiNetworkError semantics via error field for HTTP failures without cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 404 })),
    );

    const client = new ApiClient({
      baseUrl: "https://api.test",
      cacheStore: createMemoryCacheStore(),
      maxRetries: 0,
    });

    const result = await client.cachedGet("/api/yields");

    expect(result.data).toBeNull();
    expect(result.offline).toBe(false);
    expect(result.error).toContain("404");
  });

  it("rethrows caller cancellation", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
          controller.abort();
        });
      }),
    );

    const client = new ApiClient({
      baseUrl: "https://api.test",
      cacheStore: createMemoryCacheStore(),
      maxRetries: 0,
    });

    await expect(
      client.cachedGet("/api/yields", { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("exports a memory store usable as ApiCacheStore", async () => {
    const store = createMemoryCacheStore();
    store.set("k", { data: { a: 1 }, fetchedAt: Date.now() });
    expect(await store.get("k")).toMatchObject({ data: { a: 1 } });
    expect(await store.get("missing")).toBeNull();
    // Sanity: ApiNetworkError import kept for type parity in this suite.
    expect(ApiNetworkError).toBeDefined();
  });
});
