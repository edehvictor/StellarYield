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

import { Registry, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import { getYieldData } from "../services/yieldService";
import { metrics as httpMetrics } from "../middleware/metrics";

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
