/**
 * Keeper Heartbeat Monitor & Degraded Mode Recovery Registry (#1034)
 *
 * Tracks last heartbeat timestamps for rebalance, liquidation, reward, and indexer workers.
 * Computes freshness status (healthy | stale | missing) and provides degraded-mode recovery guidance.
 */

export type KeeperWorkerName = "rebalance" | "liquidation" | "reward" | "indexer";

export type KeeperHealthStatus = "healthy" | "stale" | "missing";

export interface KeeperMetadata {
  name: KeeperWorkerName;
  status: KeeperHealthStatus;
  lastHeartbeat: string | null;
  ageMs: number | null;
  degradedBehavior: string;
  recoveryGuidance: string;
}

export interface KeepersHealthSummary {
  status: "healthy" | "degraded";
  staleCount: number;
  missingCount: number;
  keepers: Record<KeeperWorkerName, KeeperMetadata>;
  timestamp: string;
}

export const KEEPER_WORKER_NAMES: readonly KeeperWorkerName[] = [
  "rebalance",
  "liquidation",
  "reward",
  "indexer",
] as const;

export const HEARTBEAT_THRESHOLDS = {
  HEALTHY_MAX_AGE_MS: 60_000,   // 1 minute
  STALE_MAX_AGE_MS: 180_000,    // 3 minutes
};

export const KEEPER_DEGRADED_BEHAVIOR: Record<KeeperWorkerName, string> = {
  rebalance:
    "Portfolio drift uncorrected; vault asset allocations may diverge from target weights.",
  liquidation:
    "Undercollateralized positions are not liquidated; vault collateral ratio at risk of bad debt.",
  reward:
    "Yield harvesting paused; auto-compounding rewards and fee distributions are delayed.",
  indexer:
    "On-chain ledger events not indexed; dashboard transaction history and balances may lag.",
};

export const KEEPER_RECOVERY_GUIDANCE: Record<KeeperWorkerName, string> = {
  rebalance:
    "Check rebalance queue depth, verify Soroban RPC endpoint latency, and restart rebalance keeper: `docker compose restart keeper-rebalance`.",
  liquidation:
    "Verify oracle price feed freshness, check liquidation signer balance for gas, and restart liquidation keeper: `docker compose restart keeper-liquidation`.",
  reward:
    "Check gas balance on reward distribution key and restart compound worker: `docker compose restart keeper-compound`.",
  indexer:
    "Verify Horizon RPC connectivity, inspect database write latency, and restart indexer service: `docker compose restart indexer`.",
};

export class KeeperHeartbeatRegistry {
  private heartbeats = new Map<KeeperWorkerName, number>();

  /**
   * Records a heartbeat timestamp for a specific keeper worker.
   */
  recordHeartbeat(worker: KeeperWorkerName, timestamp: number = Date.now()): void {
    this.heartbeats.set(worker, timestamp);
  }

  /**
   * Clears heartbeats (primarily for test resets).
   */
  clear(): void {
    this.heartbeats.clear();
  }

  /**
   * Evaluates the health status of a specific keeper worker.
   */
  getWorkerHealth(worker: KeeperWorkerName, now: number = Date.now()): KeeperMetadata {
    const lastTimestamp = this.heartbeats.get(worker) ?? null;

    if (lastTimestamp === null) {
      return {
        name: worker,
        status: "missing",
        lastHeartbeat: null,
        ageMs: null,
        degradedBehavior: KEEPER_DEGRADED_BEHAVIOR[worker],
        recoveryGuidance: KEEPER_RECOVERY_GUIDANCE[worker],
      };
    }

    const ageMs = Math.max(0, now - lastTimestamp);
    const status: KeeperHealthStatus =
      ageMs <= HEARTBEAT_THRESHOLDS.HEALTHY_MAX_AGE_MS ? "healthy" : "stale";

    return {
      name: worker,
      status,
      lastHeartbeat: new Date(lastTimestamp).toISOString(),
      ageMs,
      degradedBehavior: KEEPER_DEGRADED_BEHAVIOR[worker],
      recoveryGuidance: KEEPER_RECOVERY_GUIDANCE[worker],
    };
  }

  /**
   * Aggregates health summary across all four standard keeper workers.
   */
  getSummary(now: number = Date.now()): KeepersHealthSummary {
    const keepers = {} as Record<KeeperWorkerName, KeeperMetadata>;
    let staleCount = 0;
    let missingCount = 0;

    for (const name of KEEPER_WORKER_NAMES) {
      const info = this.getWorkerHealth(name, now);
      keepers[name] = info;
      if (info.status === "stale") staleCount++;
      if (info.status === "missing") missingCount++;
    }

    const isDegraded = staleCount > 0 || missingCount > 0;

    return {
      status: isDegraded ? "degraded" : "healthy",
      staleCount,
      missingCount,
      keepers,
      timestamp: new Date(now).toISOString(),
    };
  }
}

export const keeperHeartbeatRegistry = new KeeperHeartbeatRegistry();
