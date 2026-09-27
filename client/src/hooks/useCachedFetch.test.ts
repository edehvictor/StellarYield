import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useCachedFetch } from "./useCachedFetch";
import {
  buildCacheKey,
  createMemoryCacheStore,
} from "../lib/cachedFetch";

function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useCachedFetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads data and applies select", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ data: { n: 1 } }));
    const { result } = renderHook(() =>
      useCachedFetch<{ n: number }>("/api/thing", {
        store: createMemoryCacheStore(),
        fetchImpl,
        select: (json) => (json as { data: { n: number } }).data,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ n: 1 });
    });
    expect(result.current.isOffline).toBe(false);
    expect(result.current.isFromCache).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("serves cached data with isOffline when the network fails", async () => {
    const store = createMemoryCacheStore();
    store.set(buildCacheKey("GET", "/api/thing"), {
      data: { data: { n: 7 } },
      fetchedAt: Date.now(),
    });
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const { result } = renderHook(() =>
      useCachedFetch<{ n: number }>("/api/thing", {
        store,
        fetchImpl,
        select: (json) => (json as { data: { n: number } }).data,
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ n: 7 });
    });
    expect(result.current.isOffline).toBe(true);
    expect(result.current.isFromCache).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("refetches on the browser online event and clears the offline flag", async () => {
    const store = createMemoryCacheStore();
    store.set(buildCacheKey("GET", "/api/thing"), {
      data: { data: { n: 7 } },
      fetchedAt: Date.now(),
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(okJson({ data: { n: 9 } }));

    const { result } = renderHook(() =>
      useCachedFetch<{ n: number }>("/api/thing", {
        store,
        fetchImpl,
        select: (json) => (json as { data: { n: number } }).data,
      }),
    );

    await waitFor(() => {
      expect(result.current.isOffline).toBe(true);
    });
    expect(result.current.data).toEqual({ n: 7 });

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ n: 9 });
    });
    expect(result.current.isOffline).toBe(false);
    expect(result.current.isFromCache).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces an error when the network fails with no cache", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const { result } = renderHook(() =>
      useCachedFetch("/api/thing", {
        store: createMemoryCacheStore(),
        fetchImpl,
      }),
    );

    await waitFor(() => {
      expect(result.current.error).toBe("fetch failed");
    });
    expect(result.current.data).toBeNull();
    expect(result.current.isOffline).toBe(true);
  });

  it("does not fetch while disabled", async () => {
    const fetchImpl = vi.fn();
    const { result } = renderHook(() =>
      useCachedFetch("/api/thing", {
        store: createMemoryCacheStore(),
        fetchImpl,
        enabled: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
