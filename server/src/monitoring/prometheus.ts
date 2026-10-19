/**
 * Prometheus Metrics Exporter
 *
 * Exposes protocol and infrastructure metrics in Prometheus text format
 * for scraping by a Prometheus server and visualization in Grafana.
 *
 * Metrics exposed:
 *  - stellaryield_tvl_usd{vault}          — Total Value Locked per vault
 *  - stellaryield_apy_percent{vault}       — Current APY per vault
 *  - stellaryield_depositors_total         — Total unique depositors
 *  - stellaryield_http_request_duration_ms — API response time histogram
 *  - stellaryield_db_pool_status           — DB connection pool health (1=up, 0=down)
 *  - stellaryield_indexer_lag_ledgers      — Ledgers behind the chain tip
 *
 * Security: no wallet addresses or user-specific data is included.
 */

import { Registry, Gauge, Histogram, Counter, collectDefaultMetrics } from "prom-client";
import { getYieldData } from "../services/yieldService";
import { metrics as httpMetrics } from "../middleware/metrics";
import { sorobanRpcFailoverService } from "../services/sorobanRpcFailoverService";

// ── Registry ────────────────────────────────────────────────────────────

/** Isolated registry — avoids polluting the default global registry. */
export const prometheusRegistry = new Registry();

collectDefaultMetrics({ register: prometheusRegistry, prefix: "stellaryield_node_" });

// ── Protocol metrics ────────────────────────────────────────────────────

const tvlGauge = new Gauge({
  name: "stellaryield_tvl_usd",
  help: "Total Value Locked in USD per vault/protocol",
  labelNames: ["vault"] as const,
  registers: [prometheusRegistry],
});

const apyGauge = new Gauge({
  name: "stellaryield_apy_percent",
  help: "Current APY percentage per vault/protocol",
  labelNames: ["vault"] as const,
  registers: [prometheusRegistry],
});

const depositorsGauge = new Gauge({
  name: "stellaryield_depositors_total",
  help: "Total number of unique depositors across all vaults",
  registers: [prometheusRegistry],
});

// ── Infrastructure metrics ──────────────────────────────────────────────

const httpDurationHistogram = new Histogram({
  name: "stellaryield_http_request_duration_ms",
  help: "HTTP API response time in milliseconds",
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [prometheusRegistry],
});

const dbPoolGauge = new Gauge({
  name: "stellaryield_db_pool_status",
  help: "Database connection pool health (1 = up, 0 = down)",
  registers: [prometheusRegistry],
});

const indexerLagGauge = new Gauge({
  name: "stellaryield_indexer_lag_ledgers",
  help: "Number of ledgers the indexer is behind the chain tip",
  registers: [prometheusRegistry],
});

// ── Soroban RPC Failover & Health metrics ───────────────────────────────

export const sorobanRpcFailoverCounter = new Counter({
  name: "stellaryield_soroban_rpc_failover_total",
  help: "Total number of Soroban RPC failover transitions",
  labelNames: ["from_endpoint", "to_endpoint", "reason"] as const,
  registers: [prometheusRegistry],
});

export const sorobanRpcEndpointStatusGauge = new Gauge({
  name: "stellaryield_soroban_rpc_endpoint_status",
  help: "Health status of Soroban RPC endpoint (1 = healthy, 2 = degraded, 0 = down)",
  labelNames: ["endpoint"] as const,
  registers: [prometheusRegistry],
});

export const sorobanRpcRequestsCounter = new Counter({
  name: "stellaryield_soroban_rpc_requests_total",
  help: "Total number of Soroban RPC requests handled per endpoint",
  labelNames: ["endpoint", "status"] as const,
  registers: [prometheusRegistry],
});

export const sorobanRpcLatencyGauge = new Gauge({
  name: "stellaryield_soroban_rpc_latency_ms",
  help: "Observed latency in milliseconds for Soroban RPC endpoint",
  labelNames: ["endpoint"] as const,
  registers: [prometheusRegistry],
});

export const sorobanRpcActiveEndpointGauge = new Gauge({
  name: "stellaryield_soroban_rpc_active",
  help: "Currently active Soroban RPC endpoint (1 = active, 0 = standby)",
  labelNames: ["endpoint"] as const,
  registers: [prometheusRegistry],
});

// Hook into failover service events
sorobanRpcFailoverService.registerMetricsListener({
  onFailover: (from, to, reason) => {
    sorobanRpcFailoverCounter.inc({
      from_endpoint: from,
      to_endpoint: to,
      reason: reason.substring(0, 50),
    });
  },
  onRequest: (endpoint, status, latencyMs) => {
    sorobanRpcRequestsCounter.inc({ endpoint, status });
    sorobanRpcLatencyGauge.set({ endpoint }, latencyMs);
  },
});

// ── Metric collection ───────────────────────────────────────────────────

/**
 * Refresh all protocol-level gauges from the yield service.
 * Called on each scrape so values are always fresh.
 */
async function refreshProtocolMetrics(): Promise<void> {
  try {
    const yields = await getYieldData();
    for (const y of yields) {
      tvlGauge.set({ vault: y.protocolName }, y.tvl);
      apyGauge.set({ vault: y.protocolName }, y.apy);
    }
  } catch {
    // Non-fatal — stale values remain until next successful refresh
  }
}

/**
 * Refresh infrastructure metrics from the health endpoint data.
 * Accepts pre-fetched health status to avoid duplicate DB calls.
 */
export function refreshInfraMetrics(opts: {
  dbUp: boolean;
  indexerLag: number;
  depositorCount: number;
}): void {
  dbPoolGauge.set(opts.dbUp ? 1 : 0);
  indexerLagGauge.set(opts.indexerLag);
  depositorsGauge.set(opts.depositorCount);

  // Sync Soroban RPC endpoint gauges
  const endpoints = sorobanRpcFailoverService.getEndpoints();
  const activeUrl = sorobanRpcFailoverService.getActiveEndpoint();
  for (const ep of endpoints) {
    const statusVal = ep.status === "healthy" ? 1 : ep.status === "degraded" ? 2 : 0;
    sorobanRpcEndpointStatusGauge.set({ endpoint: ep.url }, statusVal);
    sorobanRpcActiveEndpointGauge.set({ endpoint: ep.url }, ep.url === activeUrl ? 1 : 0);
    sorobanRpcLatencyGauge.set({ endpoint: ep.url }, ep.latencyMs);
  }

  // Sync HTTP latencies from the in-memory metrics store
  const latencies = httpMetrics.requestLatencies;
  for (const ms of latencies) {
    httpDurationHistogram.observe(ms);
  }
  // Clear synced latencies to avoid double-counting on next scrape
  httpMetrics.requestLatencies.length = 0;
}

/**
 * Collect and return the full Prometheus metrics payload as a string.
 * This is called by the `/metrics` route handler on each scrape.
 */
export async function collectMetrics(opts: {
  dbUp: boolean;
  indexerLag: number;
  depositorCount: number;
}): Promise<string> {
  await refreshProtocolMetrics();
  refreshInfraMetrics(opts);
  return prometheusRegistry.metrics();
}
