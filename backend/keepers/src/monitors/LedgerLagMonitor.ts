/**
 * LedgerLagMonitor — tracks the freshness of data read from the Soroban RPC.
 *
 * The keeper's VaultMonitor reads on-chain state (CDPs, cumulative index) on a
 * fixed polling interval. If the Soroban node is lagging or the RPC is
 * unreachable, the keeper will be operating on stale data — which could lead to
 * missed liquidations or incorrect collateral-ratio evaluations.
 *
 * This module provides a lightweight, singleton-friendly tracker that records
 * the timestamp of the most recent *successful* ledger read and exposes two
 * derived metrics:
 *
 *  • `dataFreshnessMs`  — milliseconds since the last successful read.
 *  • `lagStatus`        — "fresh" | "stale" | "unknown" based on configurable
 *                         thresholds.
 *
 * The health server calls `getLedgerLagSnapshot()` and includes both fields in
 * the `/health/data` response.
 *
 * Thresholds (overridable via environment variables):
 *  LEDGER_STALE_THRESHOLD_MS   — lag above which status becomes "stale".
 *                                 Default: 2 × scan interval (90 s).
 */

export type LedgerLagStatus = 'fresh' | 'stale' | 'unknown';

export interface LedgerLagSnapshot {
  /** Milliseconds since the last successful ledger read, or null if never read. */
  dataFreshnessMs: number | null;
  /** Derived freshness category. */
  lagStatus: LedgerLagStatus;
  /** ISO timestamp of the last successful ledger read, or null. */
  lastSuccessAt: string | null;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Default stale threshold: 90 seconds.
 * Intended to be roughly 2–3× the VaultMonitor scan interval (default 30 s)
 * to tolerate one missed cycle before raising an alert.
 */
export const DEFAULT_STALE_THRESHOLD_MS = Number(
  process.env.LEDGER_STALE_THRESHOLD_MS ?? String(90_000),
);

// ---------------------------------------------------------------------------
// LedgerLagMonitor
// ---------------------------------------------------------------------------

/**
 * Lightweight tracker for Soroban RPC data freshness.
 *
 * Usage:
 *   const monitor = new LedgerLagMonitor();
 *   // In VaultMonitor.scan(), after a successful RPC call:
 *   monitor.recordSuccess();
 *   // In the health server:
 *   const snap = monitor.getSnapshot();
 */
export class LedgerLagMonitor {
  private lastSuccessMs: number | null = null;
  private readonly staleThresholdMs: number;

  constructor(staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS) {
    this.staleThresholdMs = staleThresholdMs;
  }

  /**
   * Call this every time a Soroban RPC read completes successfully.
   * Thread-safe in the Node.js single-threaded model.
   */
  recordSuccess(nowMs: number = Date.now()): void {
    this.lastSuccessMs = nowMs;
  }

  /**
   * Return a point-in-time snapshot of the ledger lag metrics.
   */
  getSnapshot(nowMs: number = Date.now()): LedgerLagSnapshot {
    if (this.lastSuccessMs === null) {
      return { dataFreshnessMs: null, lagStatus: 'unknown', lastSuccessAt: null };
    }

    const dataFreshnessMs = Math.max(0, nowMs - this.lastSuccessMs);
    const lagStatus: LedgerLagStatus =
      dataFreshnessMs > this.staleThresholdMs ? 'stale' : 'fresh';

    return {
      dataFreshnessMs,
      lagStatus,
      lastSuccessAt: new Date(this.lastSuccessMs).toISOString(),
    };
  }

  /** Reset state — useful in tests. */
  reset(): void {
    this.lastSuccessMs = null;
  }
}

// ---------------------------------------------------------------------------
// Shared singleton — imported by VaultMonitor and the health server
// ---------------------------------------------------------------------------

export const ledgerLagMonitor = new LedgerLagMonitor();
