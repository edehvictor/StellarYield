import type { ApiConfig, ApiRequestOptions, ApiVaultData, HistoricalDataPoint } from "../types";
import { ApiHttpError, ApiNetworkError, ApiTimeoutError } from "../errors";

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

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIdempotentMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/**
 * ApiClient provides methods to interact with the StellarYield backend API.
 * Every endpoint maps directly to an entry in server/openapi.yaml.
 *
 * Transient failures (timeouts, network errors, retryable HTTP statuses) are
 * retried according to {@link ApiConfig}. Non-idempotent methods are only
 * retried when explicitly marked `retrySafe`.
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
    ];
  }

  private async request<T>(
    path: string,
    options?: RequestInit,
    requestOptions?: ApiRequestOptions
  ): Promise<T> {
    const method = options?.method ?? "GET";
    const mayRetry =
      isIdempotentMethod(method) || requestOptions?.retrySafe === true;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.config.baseUrl}${path}`, {
          ...options,
          signal: controller.signal,
        });

        if (!response.ok) {
          const retryable = this.retryableStatuses.has(response.status);
          const err = new ApiHttpError(path, response.status, response.statusText, retryable);
          if (mayRetry && retryable && attempt < this.maxRetries) {
            lastError = err;
            await sleep(this.retryDelayMs * Math.pow(2, attempt));
            continue;
          }
          throw err;
        }

        return (await response.json()) as T;
      } catch (err) {
        if (err instanceof ApiHttpError) {
          throw err;
        }

        const normalized = this.normalizeFetchError(path, err);
        if (mayRetry && normalized.retryable && attempt < this.maxRetries) {
          lastError = normalized;
          await sleep(this.retryDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw normalized;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new ApiNetworkError(path);
  }

  private normalizeFetchError(path: string, err: unknown): ApiTimeoutError | ApiNetworkError {
    if (err instanceof ApiTimeoutError || err instanceof ApiNetworkError) {
      return err;
    }

    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

    if (
      name === "AbortError" ||
      message.includes("aborted") ||
      message.includes("timeout") ||
      message.includes("timed out")
    ) {
      return new ApiTimeoutError(path, this.timeoutMs);
    }

    return new ApiNetworkError(path, err);
  }

  async getHealth(): Promise<{ database?: string; redis?: string; indexer?: string; horizon?: string }> {
    return this.request<{ database?: string; redis?: string; indexer?: string; horizon?: string }>("/api/health");
  }

  async getYields(): Promise<YieldItem[]> {
    return this.request<YieldItem[]>("/api/yields");
  }

  async getYieldHistory(): Promise<HistoricalDataPoint[]> {
    return this.request<HistoricalDataPoint[]>("/api/yields/history");
  }

  async getCurrentAPY(vaultId: string): Promise<number> {
    const yields = await this.getYields();
    const match = yields.find(
      (y) => (y.protocol || y.protocolName)?.toLowerCase() === vaultId.toLowerCase()
    );
    return match ? (match.apy ?? match.totalApy ?? 0) : 0;
  }

  async getTVL(vaultId: string): Promise<number> {
    const yields = await this.getYields();
    const match = yields.find(
      (y) => (y.protocol || y.protocolName)?.toLowerCase() === vaultId.toLowerCase()
    );
    return match ? (match.tvl ?? match.tvlUsd ?? 0) : 0;
  }

  async getHistoricalData(_vaultId: string, _days: number = 30): Promise<HistoricalDataPoint[]> {
    return this.getYieldHistory();
  }

  async getVaultData(vaultId: string): Promise<ApiVaultData> {
    const [apy, historicalData] = await Promise.all([
      this.getCurrentAPY(vaultId),
      this.getHistoricalData(vaultId, 30),
    ]);

    const latest = historicalData[historicalData.length - 1];
    return {
      apy,
      tvl: latest?.tvl ?? 0,
      historicalData,
    };
  }

  async getPnL(walletAddress: string): Promise<any> {
    return this.request<any>(`/api/users/${walletAddress}/pnl`);
  }

  async getLeaderboard(params?: { metric?: string; timeframe?: string; limit?: number; offset?: number }): Promise<any> {
    const query = new URLSearchParams();
    if (params?.metric) query.set("metric", params.metric);
    if (params?.timeframe) query.set("timeframe", params.timeframe);
    if (params?.limit) query.set("limit", String(params.limit));
    if (params?.offset) query.set("offset", String(params.offset));

    const path = `/api/leaderboard${query.toString() ? `?${query.toString()}` : ""}`;
    return this.request<any>(path);
  }

  async getReferrals(walletAddress: string): Promise<any> {
    return this.request<any>(`/api/referrals/${walletAddress}`);
  }

  async claimReferral(address: string): Promise<{ amount: string; txHash: string }> {
    // POST is non-idempotent — never retried unless callers opt in later.
    return this.request<{ amount: string; txHash: string }>("/api/referrals/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
  }

  async getZapQuote(fromAsset: string, toAsset: string, amount: string): Promise<any> {
    // Quote POST is safe to retry (read-only side effects).
    return this.request<any>(
      "/api/zap/quote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromAsset, toAsset, amount }),
      },
      { retrySafe: true }
    );
  }

  async getZapSupportedAssets(): Promise<{ code: string; issuer?: string; name?: string }[]> {
    return this.request<{ code: string; issuer?: string; name?: string }[]>("/api/zap/supported-assets");
  }
}
