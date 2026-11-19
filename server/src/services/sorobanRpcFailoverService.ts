/**
 * Soroban RPC Failover Service
 *
 * Provides a resilient, multi-endpoint RPC client pool for Soroban contract operations.
 * Automatically detects node unresponsiveness, rate-limits, or network failure,
 * seamlessly fails over to backup RPC endpoints, tracks granular metrics,
 * and emits typed alert hooks.
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import {
  sorobanRpcAlertService,
  type SorobanRpcAlert,
} from "./sorobanRpcAlertService";

export type EndpointHealthStatus = "healthy" | "degraded" | "down";

export interface SorobanRpcEndpointInfo {
  url: string;
  priority: number; // 0 = primary, 1 = fallback 1, etc.
  status: EndpointHealthStatus;
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalFailoversFrom: number;
  totalFailoversTo: number;
  latencyMs: number;
  lastCheckedAt: string | null;
  lastFailureReason: string | null;
  lastRecoveredAt: string | null;
}

export interface RpcFailoverIncident {
  id: string;
  timestamp: string;
  fromEndpoint: string;
  toEndpoint: string;
  reason: string;
  errorCode?: string;
  durationMs?: number;
  activePriority: number;
}

export interface SorobanRpcStatusSnapshot {
  activeEndpoint: string;
  activePriority: number;
  status: "healthy" | "failover_active" | "all_down";
  totalFailovers: number;
  configuredEndpointsCount: number;
  endpoints: SorobanRpcEndpointInfo[];
  recentFailovers: RpcFailoverIncident[];
  recentAlerts: SorobanRpcAlert[];
  timestamp: string;
}

export interface FailoverCallOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export class SorobanRpcFailoverError extends Error {
  public readonly code: string;
  public readonly endpointErrors: Array<{ endpoint: string; error: string }>;
  public readonly retryable: boolean;

  constructor(
    message: string,
    code: string,
    endpointErrors: Array<{ endpoint: string; error: string }> = [],
    retryable = true,
  ) {
    super(message);
    this.name = "SorobanRpcFailoverError";
    this.code = code;
    this.endpointErrors = endpointErrors;
    this.retryable = retryable;
  }
}

export interface SorobanRpcFailoverConfig {
  primaryUrl?: string;
  fallbackUrls?: string[];
  failureThreshold?: number;
  timeoutMs?: number;
}

export class SorobanRpcFailoverService {
  private endpoints: SorobanRpcEndpointInfo[] = [];
  private activeIndex = 0;
  private totalFailovers = 0;
  private recentFailovers: RpcFailoverIncident[] = [];
  private readonly maxFailoverHistory = 50;
  private failureThreshold: number;
  private defaultTimeoutMs: number;
  private serverInstances: Map<string, SorobanRpc.Server> = new Map();

  // Metrics listener hooks (for Prometheus or other observers)
  private metricsListeners: Array<{
    onFailover?: (from: string, to: string, reason: string) => void;
    onRequest?: (endpoint: string, status: "success" | "failure", latencyMs: number) => void;
  }> = [];

  constructor(config?: SorobanRpcFailoverConfig) {
    this.failureThreshold =
      config?.failureThreshold ??
      Number(process.env.SOROBAN_RPC_FAILURE_THRESHOLD ?? "2");
    this.defaultTimeoutMs =
      config?.timeoutMs ??
      Number(process.env.SOROBAN_RPC_TIMEOUT_MS ?? "10000");

    this.initializeEndpoints(config);
  }

  /**
   * Initializes endpoint pool from config or environment variables.
   */
  public initializeEndpoints(config?: SorobanRpcFailoverConfig): void {
    const primaryUrl =
      config?.primaryUrl ??
      process.env.SOROBAN_RPC_URL ??
      "https://soroban-testnet.stellar.org";

    const fallbackEnv = process.env.SOROBAN_RPC_FALLBACK_URLS;
    let fallbackList: string[] = [];

    if (config?.fallbackUrls && config.fallbackUrls.length > 0) {
      fallbackList = config.fallbackUrls;
    } else if (fallbackEnv) {
      fallbackList = fallbackEnv
        .split(",")
        .map((u) => u.trim())
        .filter((u) => u.length > 0 && u !== primaryUrl);
    } else {
      // Default fallbacks if none provided
      fallbackList = [
        "https://soroban-rpc-fallback.stellaryield.com",
        "https://soroban-testnet.stellar.org",
      ].filter((u) => u !== primaryUrl);
    }

    const uniqueUrls = [primaryUrl, ...fallbackList].filter(
      (url, idx, arr) => arr.indexOf(url) === idx,
    );

    this.endpoints = uniqueUrls.map((url, index) => ({
      url,
      priority: index,
      status: "healthy",
      consecutiveFailures: 0,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalFailoversFrom: 0,
      totalFailoversTo: 0,
      latencyMs: 0,
      lastCheckedAt: null,
      lastFailureReason: null,
      lastRecoveredAt: null,
    }));

    this.activeIndex = 0;
    this.serverInstances.clear();
  }

  /**
   * Retrieve cached or new SorobanRpc.Server instance for an endpoint.
   */
  public getServer(endpointUrl?: string): SorobanRpc.Server {
    const targetUrl = endpointUrl ?? this.getActiveEndpoint();
    let server = this.serverInstances.get(targetUrl);
    if (!server) {
      server = new SorobanRpc.Server(targetUrl);
      this.serverInstances.set(targetUrl, server);
    }
    return server;
  }

  /**
   * Returns current active endpoint URL.
   */
  public getActiveEndpoint(): string {
    if (this.endpoints.length === 0) {
      return "https://soroban-testnet.stellar.org";
    }
    return this.endpoints[this.activeIndex].url;
  }

  /**
   * Returns current active endpoint priority (0 = primary).
   */
  public getActivePriority(): number {
    if (this.endpoints.length === 0) return 0;
    return this.endpoints[this.activeIndex].priority;
  }

  /**
   * Get all endpoint metrics.
   */
  public getEndpoints(): SorobanRpcEndpointInfo[] {
    return this.endpoints.map((e) => ({ ...e }));
  }

  /**
   * Get recent failover incidents.
   */
  public getRecentFailovers(limit = 20): RpcFailoverIncident[] {
    return this.recentFailovers.slice(0, limit);
  }

  /**
   * Total number of failover transitions occurred.
   */
  public getTotalFailovers(): number {
    return this.totalFailovers;
  }

  /**
   * Register a metrics observer callback.
   */
  public registerMetricsListener(listener: {
    onFailover?: (from: string, to: string, reason: string) => void;
    onRequest?: (endpoint: string, status: "success" | "failure", latencyMs: number) => void;
  }): () => void {
    this.metricsListeners.push(listener);
    return () => {
      this.metricsListeners = this.metricsListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Checks if an error is retryable and indicates an endpoint issue.
   */
  public isRetryableRpcError(error: unknown): boolean {
    if (!error) return false;
    const msg = error instanceof Error ? error.message : String(error);
    const code = (error as Record<string, unknown>).code;

    // Network & transport errors
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET"
    ) {
      return true;
    }

    // Timeout
    if (msg.toLowerCase().includes("timeout") || msg.toLowerCase().includes("timed out")) {
      return true;
    }

    // HTTP 5xx or bad gateway / service unavailable
    if (
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.toLowerCase().includes("unreachable")
    ) {
      return true;
    }

    return false;
  }

  /**
   * Execute an async promise with a timeout.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Soroban RPC timeout after ${ms}ms`)), ms),
      ),
    ]);
  }

  /**
   * Execute an operation with automatic failover across configured RPC endpoints.
   *
   * @param operation Function receiving the active SorobanRpc.Server and endpoint URL.
   * @param options Execution options (timeout, retries).
   */
  public async executeWithFailover<T>(
    operation: (server: SorobanRpc.Server, endpointUrl: string) => Promise<T>,
    options?: FailoverCallOptions,
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = options?.maxRetries ?? this.endpoints.length;
    const endpointErrors: Array<{ endpoint: string; error: string }> = [];

    const attemptsCount = Math.max(1, Math.min(maxRetries, this.endpoints.length));

    for (let attempt = 0; attempt < attemptsCount; attempt++) {
      const currentEndpoint = this.endpoints[this.activeIndex];
      const server = this.getServer(currentEndpoint.url);
      const start = Date.now();

      currentEndpoint.totalRequests++;
      currentEndpoint.lastCheckedAt = new Date().toISOString();

      try {
        const result = await this.withTimeout(
          operation(server, currentEndpoint.url),
          timeoutMs,
        );

        const latency = Date.now() - start;
        currentEndpoint.latencyMs = latency;
        currentEndpoint.totalSuccesses++;
        currentEndpoint.consecutiveFailures = 0;
        currentEndpoint.status = "healthy";

        this.notifyRequestMetrics(currentEndpoint.url, "success", latency);
        return result;
      } catch (err) {
        const latency = Date.now() - start;
        const errMsg = err instanceof Error ? err.message : String(err);
        endpointErrors.push({ endpoint: currentEndpoint.url, error: errMsg });

        currentEndpoint.totalFailures++;
        currentEndpoint.consecutiveFailures++;
        currentEndpoint.lastFailureReason = errMsg;
        currentEndpoint.latencyMs = latency;

        if (currentEndpoint.consecutiveFailures >= this.failureThreshold) {
          currentEndpoint.status = "down";
        } else {
          currentEndpoint.status = "degraded";
        }

        this.notifyRequestMetrics(currentEndpoint.url, "failure", latency);

        // If there are other endpoints available, attempt failover
        if (this.endpoints.length > 1 && attempt < attemptsCount - 1) {
          await this.triggerFailover(
            currentEndpoint.url,
            `Endpoint failed: ${errMsg}`,
            (err as Record<string, unknown>)?.code as string | undefined,
          );
        }
      }
    }

    // Check if all endpoints are down
    const allDown = this.endpoints.every((e) => e.status === "down");
    if (allDown) {
      await sorobanRpcAlertService.dispatchAlert({
        severity: "CRITICAL",
        eventType: "ALL_ENDPOINTS_DOWN",
        message: "All configured Soroban RPC endpoints are unreachable. Transactions cannot be submitted or simulated.",
        reason: "All endpoints failed consecutively.",
        consecutiveFailures: this.endpoints.reduce((acc, e) => acc + e.consecutiveFailures, 0),
        totalFailovers: this.totalFailovers,
        details: { endpointErrors },
      });
    }

    throw new SorobanRpcFailoverError(
      "All Soroban RPC endpoints are currently unavailable. Failover exhausted.",
      allDown ? "ALL_SOROBAN_RPC_ENDPOINTS_DOWN" : "SOROBAN_RPC_OPERATION_FAILED",
      endpointErrors,
      true,
    );
  }

  /**
   * Triggers a failover from current endpoint to the next best available endpoint.
   */
  public async triggerFailover(
    fromUrl: string,
    reason: string,
    errorCode?: string,
  ): Promise<string> {
    const fromEndpoint = this.endpoints[this.activeIndex];
    fromEndpoint.totalFailoversFrom++;

    // Find next candidate endpoint (healthy first, or lowest consecutive failures)
    let bestIndex = -1;
    let lowestFailures = Infinity;

    for (let i = 0; i < this.endpoints.length; i++) {
      if (i === this.activeIndex) continue;
      const candidate = this.endpoints[i];
      if (candidate.status === "healthy") {
        bestIndex = i;
        break;
      }
      if (candidate.consecutiveFailures < lowestFailures) {
        lowestFailures = candidate.consecutiveFailures;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      // Rotate round-robin as fallback
      bestIndex = (this.activeIndex + 1) % this.endpoints.length;
    }

    const previousIndex = this.activeIndex;
    this.activeIndex = bestIndex;
    const toEndpoint = this.endpoints[this.activeIndex];
    toEndpoint.totalFailoversTo++;
    this.totalFailovers++;

    const incident: RpcFailoverIncident = {
      id: `failover-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      fromEndpoint: fromUrl,
      toEndpoint: toEndpoint.url,
      reason,
      errorCode,
      activePriority: toEndpoint.priority,
    };

    this.recentFailovers.unshift(incident);
    if (this.recentFailovers.length > this.maxFailoverHistory) {
      this.recentFailovers.pop();
    }

    // Notify Prometheus / metric observers
    this.notifyFailoverMetrics(fromUrl, toEndpoint.url, reason);

    // Dispatch typed Alert Hook
    await sorobanRpcAlertService.dispatchAlert({
      severity: toEndpoint.priority === 0 ? "INFO" : "HIGH",
      eventType: "FAILOVER_TRIGGERED",
      message: `Soroban RPC failover triggered: switched from ${fromUrl} to ${toEndpoint.url} (priority ${toEndpoint.priority})`,
      fromEndpoint: fromUrl,
      toEndpoint: toEndpoint.url,
      failedEndpoint: fromUrl,
      reason,
      consecutiveFailures: fromEndpoint.consecutiveFailures,
      totalFailovers: this.totalFailovers,
      details: {
        previousPriority: this.endpoints[previousIndex]?.priority,
        newPriority: toEndpoint.priority,
        errorCode,
      },
    });

    return toEndpoint.url;
  }

  /**
   * Manual failover switch by operator or test.
   */
  public async manualFailover(
    targetUrl?: string,
    reason = "Manual operator failover triggered",
  ): Promise<{ success: boolean; activeEndpoint: string; previousEndpoint: string }> {
    const previous = this.getActiveEndpoint();
    if (targetUrl) {
      const idx = this.endpoints.findIndex((e) => e.url === targetUrl);
      if (idx !== -1) {
        this.activeIndex = idx;
        this.totalFailovers++;
        this.notifyFailoverMetrics(previous, targetUrl, reason);
        return { success: true, activeEndpoint: targetUrl, previousEndpoint: previous };
      }
    }
    const newEndpoint = await this.triggerFailover(previous, reason, "MANUAL_FAILOVER");
    return { success: true, activeEndpoint: newEndpoint, previousEndpoint: previous };
  }

  /**
   * Tests an individual endpoint for health and returns latency.
   */
  public async checkEndpointHealth(
    url: string,
    timeoutMs = 5000,
  ): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const server = this.getServer(url);
    const start = Date.now();
    try {
      await this.withTimeout(server.getNetwork(), timeoutMs);
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Probes higher priority endpoints (e.g. primary at priority 0)
   * and gracefully fails back if they have recovered.
   */
  public async probeAndRecover(): Promise<void> {
    // If we're already on primary, just verify health
    if (this.activeIndex === 0) {
      const health = await this.checkEndpointHealth(this.endpoints[0].url);
      this.endpoints[0].lastCheckedAt = new Date().toISOString();
      this.endpoints[0].latencyMs = health.latencyMs;
      if (health.healthy) {
        this.endpoints[0].status = "healthy";
        this.endpoints[0].consecutiveFailures = 0;
      }
      return;
    }

    // Check primary node
    const primary = this.endpoints[0];
    const health = await this.checkEndpointHealth(primary.url);
    primary.lastCheckedAt = new Date().toISOString();
    primary.latencyMs = health.latencyMs;

    if (health.healthy) {
      primary.status = "healthy";
      primary.consecutiveFailures = 0;
      primary.lastRecoveredAt = new Date().toISOString();

      const previousActive = this.getActiveEndpoint();
      this.activeIndex = 0;
      this.totalFailovers++;

      this.notifyFailoverMetrics(previousActive, primary.url, "Primary node recovered");

      await sorobanRpcAlertService.dispatchAlert({
        severity: "INFO",
        eventType: "PRIMARY_RECOVERED",
        message: `Primary Soroban RPC node ${primary.url} has recovered. Seamlessly restored active traffic to primary node.`,
        fromEndpoint: previousActive,
        toEndpoint: primary.url,
        reason: "Primary node health check succeeded.",
        consecutiveFailures: 0,
        totalFailovers: this.totalFailovers,
      });
    }
  }

  /**
   * Returns a complete status snapshot for API and dashboard.
   */
  public getStatusSnapshot(): SorobanRpcStatusSnapshot {
    const active = this.endpoints[this.activeIndex];
    let overallStatus: "healthy" | "failover_active" | "all_down" = "healthy";

    const allDown = this.endpoints.every((e) => e.status === "down");
    if (allDown) {
      overallStatus = "all_down";
    } else if (this.activeIndex !== 0) {
      overallStatus = "failover_active";
    }

    return {
      activeEndpoint: active ? active.url : "https://soroban-testnet.stellar.org",
      activePriority: active ? active.priority : 0,
      status: overallStatus,
      totalFailovers: this.totalFailovers,
      configuredEndpointsCount: this.endpoints.length,
      endpoints: this.getEndpoints(),
      recentFailovers: this.getRecentFailovers(),
      recentAlerts: sorobanRpcAlertService.getHistory(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Resets all metrics and failover counters to pristine state.
   */
  public reset(): void {
    this.activeIndex = 0;
    this.totalFailovers = 0;
    this.recentFailovers = [];
    sorobanRpcAlertService.clear();
    for (const ep of this.endpoints) {
      ep.status = "healthy";
      ep.consecutiveFailures = 0;
      ep.totalRequests = 0;
      ep.totalSuccesses = 0;
      ep.totalFailures = 0;
      ep.totalFailoversFrom = 0;
      ep.totalFailoversTo = 0;
      ep.latencyMs = 0;
      ep.lastCheckedAt = null;
      ep.lastFailureReason = null;
      ep.lastRecoveredAt = null;
    }
  }

  // ── Metric notifications ────────────────────────────────────────────────

  private notifyFailoverMetrics(from: string, to: string, reason: string): void {
    for (const listener of this.metricsListeners) {
      try {
        listener.onFailover?.(from, to, reason);
      } catch (err) {
        console.error("[SorobanRpcFailoverService] Metrics listener error:", err);
      }
    }
  }

  private notifyRequestMetrics(
    endpoint: string,
    status: "success" | "failure",
    latencyMs: number,
  ): void {
    for (const listener of this.metricsListeners) {
      try {
        listener.onRequest?.(endpoint, status, latencyMs);
      } catch (err) {
        console.error("[SorobanRpcFailoverService] Metrics listener error:", err);
      }
    }
  }
}

export const sorobanRpcFailoverService = new SorobanRpcFailoverService();
