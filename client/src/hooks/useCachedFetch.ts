import { useCallback, useEffect, useRef, useState } from "react";
import {
  cachedFetch,
  type CacheStore,
} from "../lib/cachedFetch";
import { useStaleResponseGuard } from "./useStaleResponseGuard";

export interface UseCachedFetchOptions<T> {
  init?: RequestInit;
  /** Map the raw JSON body to the desired shape (default: identity). */
  select?: (json: unknown) => T;
  store?: CacheStore;
  maxAgeMs?: number;
  fetchImpl?: typeof fetch;
  /** Set false to pause fetching (default: true). */
  enabled?: boolean;
}

export interface UseCachedFetchResult<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  /** Serving cache (or showing nothing) because the network is down. */
  isOffline: boolean;
  /** Data currently displayed came from the local cache. */
  isFromCache: boolean;
  fetchedAt: number | null;
  refresh: () => void;
}

function initSignature(init?: RequestInit): string {
  if (!init) return "";
  return `${init.method ?? "GET"} ${JSON.stringify(init.headers ?? {})} ${String(init.body ?? "")}`;
}

/**
 * Read-only fetch with offline cache fallback and automatic refresh when
 * connectivity returns (`online` event) (#1125).
 */
export function useCachedFetch<T>(
  path: string,
  options: UseCachedFetchOptions<T> = {},
): UseCachedFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(options.enabled !== false);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [isFromCache, setIsFromCache] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const { startRequest, isCurrent } = useStaleResponseGuard();

  const optionsRef = useRef(options);
  const signature = initSignature(options.init);
  const enabled = options.enabled !== false;

  useEffect(() => {
    optionsRef.current = options;
  });

  const load = useCallback(async () => {
    // `signature` intentionally participates so init/body changes re-create
    // this callback and re-trigger the fetch effect.
    void signature;
    const token = startRequest();
    setIsLoading(true);
    const opts = optionsRef.current;
    const result = await cachedFetch<unknown>(path, {
      init: opts.init,
      store: opts.store,
      maxAgeMs: opts.maxAgeMs,
      fetchImpl: opts.fetchImpl,
    });
    if (!isCurrent(token)) return;

    if (result.data !== null) {
      const value = opts.select ? opts.select(result.data) : (result.data as T);
      setData(value);
      setError(null);
    } else {
      setError(result.error ?? "Request failed");
    }
    setIsOffline(result.offline);
    setIsFromCache(result.fromCache);
    if (result.fetchedAt != null) {
      setFetchedAt(result.fetchedAt);
    }
    setIsLoading(false);
  }, [path, signature, startRequest, isCurrent]);

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void load();
  }, [load, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleOnline = () => {
      void load();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [load, enabled]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return {
    data,
    isLoading,
    error,
    isOffline,
    isFromCache,
    fetchedAt,
    refresh,
  };
}
