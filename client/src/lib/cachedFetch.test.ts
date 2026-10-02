import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildCacheKey,
  cachedFetch,
  createMemoryCacheStore,
} from "./cachedFetch";

function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildCacheKey", () => {
  it("distinguishes method, path, and body", () => {
    const a = buildCacheKey("GET", "/api/yields");
    const b = buildCacheKey("POST", "/api/analytics/health/batch", '{"ids":[1]}');
    const c = buildCacheKey("POST", "/api/analytics/health/batch", '{"ids":[2]}');
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a.startsWith("sy_http_cache_v1:")).toBe(true);
  });
});

describe("cachedFetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns fresh data and stores it", async () => {
    const store = createMemoryCacheStore();
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ hello: "world" }));

    const result = await cachedFetch<{ hello: string }>("/api/thing", {
      store,
      fetchImpl,
    });

    expect(result).toMatchObject({
      data: { hello: "world" },
      fromCache: false,
      offline: false,
      error: null,
    });
    expect(result.fetchedAt).toBeTypeOf("number");

    const key = buildCacheKey("GET", "/api/thing");
    expect(store.get(key)).toMatchObject({ data: { hello: "world" } });
  });

  it("serves cache with offline flag when the network fails", async () => {
    const store = createMemoryCacheStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okJson({ rows: [1] }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    await cachedFetch("/api/thing", { store, fetchImpl });
    const second = await cachedFetch<{ rows: number[] }>("/api/thing", {
      store,
      fetchImpl,
    });

    expect(second).toMatchObject({
      data: { rows: [1] },
      fromCache: true,
      offline: true,
      error: null,
    });
  });

  it("returns an error when the network fails and no cache exists", async () => {
    const store = createMemoryCacheStore();
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const result = await cachedFetch("/api/thing", { store, fetchImpl });

    expect(result.data).toBeNull();
    expect(result.offline).toBe(true);
    expect(result.error).toBe("fetch failed");
  });

  it("serves cache on HTTP error status without marking offline", async () => {
    const store = createMemoryCacheStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okJson({ rows: [1] }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));

    await cachedFetch("/api/thing", { store, fetchImpl });
    const second = await cachedFetch("/api/thing", { store, fetchImpl });

    expect(second).toMatchObject({
      data: { rows: [1] },
      fromCache: true,
      offline: false,
      error: null,
    });
  });

  it("does not serve expired cache entries", async () => {
    const store = createMemoryCacheStore();
    const key = buildCacheKey("GET", "/api/thing");
    store.set(key, { data: { old: true }, fetchedAt: Date.now() - 10_000 });

    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await cachedFetch("/api/thing", {
      store,
      fetchImpl,
      maxAgeMs: 1_000,
    });

    expect(result.data).toBeNull();
    expect(result.error).toBe("fetch failed");
  });

  it("serves cache without hitting the network when skipNetwork is set", async () => {
    const store = createMemoryCacheStore();
    const key = buildCacheKey("GET", "/api/thing");
    store.set(key, { data: { offline: true }, fetchedAt: Date.now() });

    const fetchImpl = vi.fn();
    const result = await cachedFetch("/api/thing", {
      store,
      fetchImpl,
      skipNetwork: true,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      data: { offline: true },
      fromCache: true,
      offline: true,
      error: null,
    });
  });

  it("reports offline with an error when skipNetwork and no cache", async () => {
    const result = await cachedFetch("/api/thing", {
      store: createMemoryCacheStore(),
      fetchImpl: vi.fn(),
      skipNetwork: true,
    });

    expect(result.data).toBeNull();
    expect(result.offline).toBe(true);
    expect(result.error).toMatch(/offline/i);
  });

  it("fresh responses replace cached copies (reconnect path)", async () => {
    const store = createMemoryCacheStore();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okJson({ v: 1 }))
      .mockResolvedValueOnce(okJson({ v: 2 }));

    await cachedFetch("/api/thing", { store, fetchImpl });
    const fresh = await cachedFetch<{ v: number }>("/api/thing", {
      store,
      fetchImpl,
    });

    expect(fresh).toMatchObject({ data: { v: 2 }, fromCache: false });
    expect(store.get(buildCacheKey("GET", "/api/thing"))).toMatchObject({
      data: { v: 2 },
    });
  });

  it("participates request bodies in the cache key for POST", async () => {
    const store = createMemoryCacheStore();
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ ok: true }));

    await cachedFetch("/api/thing", {
      store,
      fetchImpl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategyIds: ["a"] }),
      },
    });

    expect(
      store.get(
        buildCacheKey(
          "POST",
          "/api/thing",
          JSON.stringify({ strategyIds: ["a"] }),
        ),
      ),
    ).not.toBeNull();
    expect(
      store.get(
        buildCacheKey(
          "POST",
          "/api/thing",
          JSON.stringify({ strategyIds: ["b"] }),
        ),
      ),
    ).toBeNull();
  });
});
