import type { ApiConfig, ApiRequestOptions, ApiVaultData, HistoricalDataPoint } from "../types";
import {
  ApiCancelledError,
  ApiHttpError,
  ApiNetworkError,
  ApiTimeoutError,
} from "../errors";

export interface ApiRegisteredEndpoint {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  pathPattern: string;
  description: string;
}

export interface YieldItem {
  protocol?: string;
  protocolName?: string;
  asset?: string;
  apy: number;
  totalApy?: number;
  tvl?: number;
  tvlUsd?: number;
  risk?: string;
}

export interface DepositSimulationParams {
  strategyId: string;
  amount: number;
  token: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function isIdempotentMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/**
 * Combines the client timeout with an optional caller AbortSignal.
 * Distinguishes timeout aborts from caller cancellation.
 */
function createLinkedAbort(
  timeoutMs: number,
  external?: AbortSignal
): { signal: AbortSignal; cleanup: () => void; wasCallerCancel: () => boolean } {
  const controller = new AbortController();
  let callerCancel = false;

  const onExternal = () => {
    callerCancel = true;
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  if (external) {
    if (external.aborted) {
      onExternal();
    } else {
      external.addEventListener("abort", onExternal, { once: true });
    }
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternal);
    },
    wasCallerCancel: () => callerCancel || Boolean(external?.aborted),
  };
}

/**
 * ApiClient provides methods to interact with the StellarYield backend API.
 * Every endpoint maps directly to an entry in server/openapi.yaml.
 *
 * Transient failures (timeouts, network errors, retryable HTTP statuses) are
 * retried according to {@link ApiConfig}. Non-idempotent methods are only
 * retried when explicitly marked `retrySafe`. Caller AbortSignals cancel
 * without retries and surface {@link ApiCancelledError}.
 */
export class ApiClient {
  private config: ApiConfig;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly retryableStatuses: Set<number>;

  constructor(config: ApiConfig) {
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.retryableStatuses = new Set(config.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES);
  }

  public getRegisteredEndpoints(): ApiRegisteredEndpoint[] {
    return [
      { method: "GET", pathPattern: "/api/health", description: "System health check" },
      { method: "GET", pathPattern: "/api/yields", description: "Get current yield data" },
      { method: "GET", pathPattern: "/api/yields/history", description: "Historical APY data" },
      { method: "GET", pathPattern: "/api/users/{walletAddress}/pnl", description: "User PnL data" },
      { method: "GET", pathPattern: "/api/leaderboard", description: "User leaderboard" },
      { method: "GET", pathPattern: "/api/referrals/{walletAddress}", description: "Referral info" },
      { method: "POST", pathPattern: "/api/referrals/claim", description: "Claim referral rewards" },
      { method: "POST", pathPattern: "/api/zap/quote", description: "Get token swap quote" },
      { method: "GET", pathPattern: "/api/zap/supported-assets", description: "Get supported zap assets" },
      {
        method: "POST",
        pathPattern: "/api/simulator/deposit",
        description: "Simulate a deposit allocation preview",
      },
    ];
  }

  private throwIfCancelled(path: string, signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ApiCancelledError(path);
    }
  }

  private async request<T>(
    path: string,
    options?: RequestInit,
    requestOptions?: ApiRequestOptions
  ): Promise<T> {
    const method = options?.method ?? "GET";
    const mayRetry =
      isIdempotentMethod(method) || requestOptions?.retrySafe === true;
    const externalSignal = requestOptions?.signal;

    this.throwIfCancelled(path, externalSignal);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.throwIfCancelled(path, externalSignal);

      const linked = createLinkedAbort(this.timeoutMs, externalSignal);

      try {
        const response = await fetch(`${this.config.baseUrl}${path}`, {
          ...options,
          signal: linked.signal,
        });

        if (!response.ok) {
          const retryable = this.retryableStatuses.has(response.status);
          const err = new ApiHttpError(path, response.status, response.statusText, retryable);
          if (mayRetry && retryable && attempt < this.maxRetries) {
            lastError = err;
            await sleep(this.retryDelayMs * Math.pow(2, attempt), externalSignal);
            continue;
          }
          throw err;
        }

        return (await response.json()) as T;
      } catch (err) {
        if (err instanceof ApiHttpError || err instanceof ApiCancelledError) {
          throw err;
        }

        if (linked.wasCallerCancel() || externalSignal?.aborted) {
          throw new ApiCancelledError(path);
        }

        const normalized = this.normalizeFetchError(path, err, linked.wasCallerCancel());
        if (normalized instanceof ApiCancelledError) {
          throw normalized;
        }
        if (mayRetry && normalized.retryable && attempt < this.maxRetries) {
          lastError = normalized;
          try {
            await sleep(this.retryDelayMs * Math.pow(2, attempt), externalSignal);
          } catch {
            throw new ApiCancelledError(path);
          }
          continue;
        }
        throw normalized;
      } finally {
        linked.cleanup();
      }
    }

    throw lastError ?? new ApiNetworkError(path);
  }

  private normalizeFetchError(
    path: string,
    err: unknown,
    callerCancelled: boolean
  ): ApiTimeoutError | ApiNetworkError | ApiCancelledError {
    if (
      err instanceof ApiTimeoutError ||
      err instanceof ApiNetworkError ||
      err instanceof ApiCancelledError
    ) {
      return err;
    }

    if (callerCancelled) {
      return new ApiCancelledError(path);
    }

    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

    if (
      name === "AbortError" ||
      name === "TimeoutError" ||
      message.includes("aborted") ||
      message.includes("timeout") ||
      message.includes("timed out")
    ) {
      return new ApiTimeoutError(path, this.timeoutMs);
    }

    return new ApiNetworkError(path, err);
  }

  async getHealth(requestOptions?: ApiRequestOptions): Promise<{
    database?: string;
    redis?: string;
    indexer?: string;
    horizon?: string;
  }> {
    return this.request<{ database?: string; redis?: string; indexer?: string; horizon?: string }>(
      "/api/health",
      undefined,
      requestOptions
    );
  }

  async getYields(requestOptions?: ApiRequestOptions): Promise<YieldItem[]> {
    return this.request<YieldItem[]>("/api/yields", undefined, requestOptions);
  }

  async getYieldHistory(requestOptions?: ApiRequestOptions): Promise<HistoricalDataPoint[]> {
    return this.request<HistoricalDataPoint[]>("/api/yields/history", undefined, requestOptions);
  }

  async getCurrentAPY(vaultId: string, requestOptions?: ApiRequestOptions): Promise<number> {
    const yields = await this.getYields(requestOptions);
    const match = yields.find(
      (y) => (y.protocol || y.protocolName)?.toLowerCase() === vaultId.toLowerCase()
    );
    return match ? (match.apy ?? match.totalApy ?? 0) : 0;
  }

  async getTVL(vaultId: string, requestOptions?: ApiRequestOptions): Promise<number> {
    const yields = await this.getYields(requestOptions);
    const match = yields.find(
      (y) => (y.protocol || y.protocolName)?.toLowerCase() === vaultId.toLowerCase()
    );
    return match ? (match.tvl ?? match.tvlUsd ?? 0) : 0;
  }

  async getHistoricalData(
    _vaultId: string,
    _days: number = 30,
    requestOptions?: ApiRequestOptions
  ): Promise<HistoricalDataPoint[]> {
    return this.getYieldHistory(requestOptions);
  }

  async getVaultData(vaultId: string, requestOptions?: ApiRequestOptions): Promise<ApiVaultData> {
    const [apy, historicalData] = await Promise.all([
      this.getCurrentAPY(vaultId, requestOptions),
      this.getHistoricalData(vaultId, 30, requestOptions),
    ]);

    const latest = historicalData[historicalData.length - 1];
    return {
      apy,
      tvl: latest?.tvl ?? 0,
      historicalData,
    };
  }

  async getPnL(walletAddress: string, requestOptions?: ApiRequestOptions): Promise<any> {
    return this.request<any>(`/api/users/${walletAddress}/pnl`, undefined, requestOptions);
  }

  async getLeaderboard(
    params?: { metric?: string; timeframe?: string; limit?: number; offset?: number },
    requestOptions?: ApiRequestOptions
  ): Promise<any> {
    const query = new URLSearchParams();
    if (params?.metric) query.set("metric", params.metric);
    if (params?.timeframe) query.set("timeframe", params.timeframe);
    if (params?.limit) query.set("limit", String(params.limit));
    if (params?.offset) query.set("offset", String(params.offset));

    const path = `/api/leaderboard${query.toString() ? `?${query.toString()}` : ""}`;
    return this.request<any>(path, undefined, requestOptions);
  }

  async getReferrals(walletAddress: string, requestOptions?: ApiRequestOptions): Promise<any> {
    return this.request<any>(`/api/referrals/${walletAddress}`, undefined, requestOptions);
  }

  async claimReferral(
    address: string,
    requestOptions?: ApiRequestOptions
  ): Promise<{ amount: string; txHash: string }> {
    // POST is non-idempotent — never retried unless callers opt in later.
    return this.request<{ amount: string; txHash: string }>(
      "/api/referrals/claim",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      },
      requestOptions
    );
  }

  /**
   * Fetch a zap swap quote. Supports AbortSignal so clients can cancel after
   * route changes or rapid input edits without applying a stale response.
   */
  async getZapQuote(
    fromAsset: string,
    toAsset: string,
    amount: string,
    requestOptions?: ApiRequestOptions
  ): Promise<any> {
    // Quote POST is safe to retry (read-only side effects) unless cancelled.
    return this.request<any>(
      "/api/zap/quote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromAsset, toAsset, amount }),
      },
      { retrySafe: requestOptions?.retrySafe ?? true, signal: requestOptions?.signal }
    );
  }

  /**
   * Run a deposit allocation simulation preview. Cancellable via AbortSignal.
   */
  async simulateDeposit(
    params: DepositSimulationParams,
    requestOptions?: ApiRequestOptions
  ): Promise<any> {
    return this.request<any>(
      "/api/simulator/deposit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      },
      { retrySafe: requestOptions?.retrySafe ?? true, signal: requestOptions?.signal }
    );
  }

  async getZapSupportedAssets(
    requestOptions?: ApiRequestOptions
  ): Promise<{ code: string; issuer?: string; name?: string }[]> {
    return this.request<{ code: string; issuer?: string; name?: string }[]>(
      "/api/zap/supported-assets",
      undefined,
      requestOptions
    );
  }
}
