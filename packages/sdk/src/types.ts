import { InvalidAmountError } from "./errors";

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

/**
 * One page of a cursor-paginated API response. A missing or null
 * `nextCursor` marks the final page.
 */
export interface ApiCursorPage<T> {
  items: T[];
  nextCursor?: string | null;
}

/** Options for {@link ApiClient.paginate} and {@link ApiClient.getAllPages}. */
export interface ApiPaginateOptions extends ApiRequestOptions {
  /** Maximum number of pages to request (default: 50). */
  maxPages?: number;
  /** Stop once this many items have been collected; extra items are dropped. */
  maxItems?: number;
  /** Query parameter used to send the cursor (default: "cursor"). */
  cursorParam?: string;
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

/**
 * A token amount in base units (e.g. stroops). Use a `bigint`, a decimal
 * string, or a `number` that is a safe integer. Fractional or unsafe numbers
 * are rejected by {@link toTokenUnits} because they cannot be represented
 * exactly.
 */
export type TokenAmount = bigint | string | number;

export interface ToTokenUnitsOptions {
  /**
   * Token decimals. When set, string inputs are read as whole-token decimal
   * amounts (e.g. `"1.5"`) and scaled into base units. Without it, strings
   * must already be whole base units. `bigint` and `number` inputs are always
   * base units.
   */
  decimals?: number;
  /** Field name used in error messages (default: "amount"). */
  field?: string;
  /** Allow negative amounts (default: false). */
  allowNegative?: boolean;
}

const INTEGER_STRING = /^-?\d+$/;
const DECIMAL_STRING = /^-?\d+\.\d+$/;

/**
 * Normalize a token amount into exact base units without ever routing the
 * value through floating point.
 *
 * - `bigint` values pass through unchanged.
 * - `number` values must be safe integers (`Number.isSafeInteger`).
 * - `string` values must be plain decimal digits; a fractional part is only
 *   accepted when `decimals` is given and does not exceed it.
 *
 * @throws {InvalidAmountError} when the input would lose precision or is malformed.
 */
export function toTokenUnits(value: TokenAmount, options: ToTokenUnitsOptions = {}): bigint {
  const field = options.field ?? "amount";
  const decimals = options.decimals;
  if (decimals !== undefined && (!Number.isSafeInteger(decimals) || decimals < 0)) {
    throw new InvalidAmountError(field, value, `decimals must be a non-negative integer, got ${decimals}`);
  }

  let units: bigint;
  if (typeof value === "bigint") {
    units = value;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidAmountError(field, value, "must be a finite number");
    }
    if (!Number.isInteger(value)) {
      throw new InvalidAmountError(
        field,
        value,
        "fractional numbers lose precision; pass base units or a decimal string with `decimals`"
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new InvalidAmountError(
        field,
        value,
        `exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); pass a bigint or a decimal string`
      );
    }
    units = BigInt(value);
  } else if (typeof value === "string") {
    units = parseAmountString(value, decimals, field);
  } else {
    throw new InvalidAmountError(field, value, `unsupported type '${typeof value}'`);
  }

  if (units < 0n && !options.allowNegative) {
    throw new InvalidAmountError(field, value, "must not be negative");
  }
  return units;
}

function parseAmountString(value: string, decimals: number | undefined, field: string): bigint {
  if (INTEGER_STRING.test(value)) {
    return BigInt(value) * 10n ** BigInt(decimals ?? 0);
  }
  if (DECIMAL_STRING.test(value)) {
    if (decimals === undefined) {
      throw new InvalidAmountError(
        field,
        value,
        "fractional strings require `decimals` to convert into base units"
      );
    }
    const negative = value.startsWith("-");
    const [whole, fraction] = (negative ? value.slice(1) : value).split(".");
    if (fraction.length > decimals) {
      throw new InvalidAmountError(
        field,
        value,
        `has ${fraction.length} fractional digits but the token only supports ${decimals}`
      );
    }
    const scale = 10n ** BigInt(decimals);
    const units = BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0"));
    return negative ? -units : units;
  }
  throw new InvalidAmountError(field, value, `'${value}' is not a decimal number string`);
}

/** Format base units as a decimal string, e.g. `formatTokenUnits(15_000_000n, 7) === "1.5"`. */
export function formatTokenUnits(units: bigint, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new InvalidAmountError("decimals", decimals, "must be a non-negative integer");
  }
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export interface DepositParams {
  from: string;
  amount: TokenAmount;
  minSharesOut?: TokenAmount;
}

export interface WithdrawParams {
  to: string;
  shares: TokenAmount;
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
