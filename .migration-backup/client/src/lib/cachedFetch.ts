/**
 * Offline-capable HTTP cache for read-only dashboard widgets (#1125).
 *
 * Successful JSON responses are persisted to localStorage so widgets can
 * render last-known data when the network is unavailable. Callers get an
 * explicit `offline` / `fromCache` signal to drive UI indicators, and
 * fresh responses always replace the cached copy.
 */

export interface CachedFetchEntry<T = unknown> {
  data: T;
  fetchedAt: number;
}

export interface CacheStore {
  get<T>(key: string): CachedFetchEntry<T> | null;
  set<T>(key: string, entry: CachedFetchEntry<T>): void;
}

export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const KEY_PREFIX = "sy_http_cache_v1:";
const MAX_PAYLOAD_CHARS = 200_000;

export function createMemoryCacheStore(): CacheStore {
  const map = new Map<string, string>();
  return {
    get<T>(key: string): CachedFetchEntry<T> | null {
      const raw = map.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as CachedFetchEntry<T>;
      } catch {
        return null;
      }
    },
    set<T>(key: string, entry: CachedFetchEntry<T>): void {
      map.set(key, JSON.stringify(entry));
    },
  };
}

export function createLocalStorageCacheStore(): CacheStore {
  const memoryFallback = createMemoryCacheStore();
  return {
    get<T>(key: string): CachedFetchEntry<T> | null {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw) as CachedFetchEntry<T>;
      } catch {
        return memoryFallback.get<T>(key);
      }
    },
    set<T>(key: string, entry: CachedFetchEntry<T>): void {
      const raw = JSON.stringify(entry);
      if (raw.length > MAX_PAYLOAD_CHARS) return;
      try {
        window.localStorage.setItem(key, raw);
      } catch {
        // Quota exceeded / private mode — keep the in-memory copy only.
        memoryFallback.set(key, entry);
      }
    },
  };
}

function bodyToString(init?: RequestInit): string | undefined {
  if (init?.body == null) return undefined;
  if (typeof init.body === "string") return init.body;
  return undefined;
}

export function buildCacheKey(
  method: string,
  path: string,
  body?: string,
): string {
  return `${KEY_PREFIX}${method.toUpperCase()} ${path}${body ? ` ${body}` : ""}`;
}

export interface CachedFetchResult<T> {
  /** Fresh or cached payload; null when nothing could be loaded. */
  data: T | null;
  /** When the served payload was fetched (network or cache write time). */
  fetchedAt: number | null;
  /** True when data was served from the local cache. */
  fromCache: boolean;
  /** True when the network was unreachable (or reported offline). */
  offline: boolean;
  /** Failure reason when no data could be served; null on success. */
  error: string | null;
}

export interface CachedFetchOptions {
  init?: RequestInit;
  store?: CacheStore;
  maxAgeMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Skip the network entirely (explicit offline / tests). */
  skipNetwork?: boolean;
}

let defaultStore: CacheStore | null = null;

function getDefaultStore(): CacheStore {
  if (!defaultStore) {
    defaultStore =
      typeof window !== "undefined" && window.localStorage
        ? createLocalStorageCacheStore()
        : createMemoryCacheStore();
  }
  return defaultStore;
}

/** Reset the module-level default store (tests). */
export function resetDefaultCacheStore(): void {
  defaultStore = null;
}

function readFreshEntry<T>(
  store: CacheStore,
  key: string,
  maxAgeMs: number,
): CachedFetchEntry<T> | null {
  const entry = store.get<T>(key);
  if (!entry || typeof entry.fetchedAt !== "number") return null;
  if (Date.now() - entry.fetchedAt > maxAgeMs) return null;
  return entry;
}

function browserReportsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function serveCache<T>(
  entry: CachedFetchEntry<T> | null,
  offline: boolean,
  error: string | null,
): CachedFetchResult<T> {
  if (entry) {
    return {
      data: entry.data,
      fetchedAt: entry.fetchedAt,
      fromCache: true,
      offline,
      error: null,
    };
  }
  return { data: null, fetchedAt: null, fromCache: false, offline, error };
}

/**
 * Fetch JSON with a persistent read-through cache.
 *
 * - Success: stores the payload and returns it (`fromCache: false`).
 * - Network failure: serves a fresh-enough cached copy (`offline: true`)
 *   or returns an error when no cache exists.
 * - HTTP error status: same cache fallback, but `offline: false`.
 *
 * Never throws for network/HTTP failures — inspect `error` instead.
 */
export async function cachedFetch<T>(
  path: string,
  options: CachedFetchOptions = {},
): Promise<CachedFetchResult<T>> {
  const init = options.init;
  const method = (init?.method ?? "GET").toUpperCase();
  const store = options.store ?? getDefaultStore();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch.bind(globalThis);
  const key = buildCacheKey(method, path, bodyToString(init));
  const cached = readFreshEntry<T>(store, key, maxAgeMs);

  const skipNetwork = options.skipNetwork === true || browserReportsOffline();

  if (!skipNetwork) {
    try {
      const response = await fetchImpl(path, {
        ...init,
        signal: options.signal,
      });

      if (response.ok) {
        const json = (await response.json()) as T;
        const fetchedAt = Date.now();
        try {
          store.set(key, { data: json, fetchedAt });
        } catch {
          // Store failures must not break the request.
        }
        return {
          data: json,
          fetchedAt,
          fromCache: false,
          offline: false,
          error: null,
        };
      }

      return serveCache(cached, false, `HTTP ${response.status}`);
    } catch (err) {
      if (options.signal?.aborted) {
        return {
          data: null,
          fetchedAt: null,
          fromCache: false,
          offline: false,
          error: "Request cancelled",
        };
      }
      const message =
        err instanceof Error && err.message ? err.message : "Network request failed";
      return serveCache(cached, true, message);
    }
  }

  return serveCache(
    cached,
    true,
    cached ? null : "You are offline and no cached data is available.",
  );
}
