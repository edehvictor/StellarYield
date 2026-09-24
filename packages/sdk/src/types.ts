export interface VaultConfig {
  contractId: string;
  networkPassphrase: string;
  rpcUrl: string;
  specHash?: string;
}

/**
 * Retry policy for ApiClient HTTP calls.
 * Timeouts and network failures are normalized into SDK error types.
 */
export interface ApiRetryConfig {
  /** Per-request timeout in milliseconds (default: 15_000). */
  timeoutMs?: number;
  /** Maximum number of retries after the first attempt (default: 2). */
  maxRetries?: number;
  /** Base delay between retries in milliseconds (default: 250). Exponential backoff. */
  retryDelayMs?: number;
  /** HTTP status codes that are safe to retry (default: 408, 429, 500, 502, 503, 504). */
  retryableStatuses?: number[];
}

/** A cached API payload and the time it was fetched. */
export interface ApiCacheEntry<T = unknown> {
  data: T;
  fetchedAt: number;
}

/**
 * Pluggable storage for {@link ApiClient.cachedGet} offline fallback.
 * Implementations may back onto localStorage, memory, or IndexedDB.
 */
export interface ApiCacheStore {
  get<T>(key: string): ApiCacheEntry<T> | null | Promise<ApiCacheEntry<T> | null>;
  set<T>(key: string, entry: ApiCacheEntry<T>): void | Promise<void>;
}

export interface ApiConfig extends ApiRetryConfig {
  baseUrl: string;
  /** Enables {@link ApiClient.cachedGet} offline/cache fallback. */
  cacheStore?: ApiCacheStore;
}

/** Options for a single ApiClient request. */
export interface ApiRequestOptions {
  /**
   * Mark a non-idempotent method (POST/PUT/PATCH/DELETE) as safe to retry.
   * GET/HEAD are always treated as idempotent.
   */
  retrySafe?: boolean;
  /**
   * AbortSignal to cancel the in-flight request (e.g. on route change or rapid input edits).
   * Cancellation surfaces as {@link ApiCancelledError}, not a timeout.
   */
  signal?: AbortSignal;
}

/** Options for {@link ApiClient.cachedGet}. */
export interface ApiCachedGetOptions extends ApiRequestOptions {
  /** Override the cache key (default: the request path). */
  cacheKey?: string;
  /** Maximum age of a cached entry to serve (default: 7 days). */
  maxAgeMs?: number;
}

/** Result of {@link ApiClient.cachedGet}. */
export interface ApiCachedGetResult<T> {
  /** Fresh or cached payload; null when nothing could be loaded. */
  data: T | null;
  /** When the served payload was fetched. */
  fetchedAt: number | null;
  /** True when data was served from the cache store. */
  fromCache: boolean;
  /** True when the request failed due to network/timeout conditions. */
  offline: boolean;
  /** Failure message when no data could be served. */
  error: string | null;
}

export interface DepositParams {
  from: string;
  amount: bigint | string;
  minSharesOut?: bigint | string;
}

export interface WithdrawParams {
  to: string;
  shares: bigint | string;
}

export interface VaultInfo {
  totalShares: string;
  totalAssets: string;
  token: string;
  admin: string;
}

export interface ApiVaultData {
  apy: number;
  tvl: number;
  historicalData: HistoricalDataPoint[];
}

export interface HistoricalDataPoint {
  timestamp: string;
  apy: number;
  tvl: number;
}

export interface SDKConfig {
  vault: VaultConfig;
  api?: ApiConfig;
}
