export type DependencyHealthStatus =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "misconfigured";

export type BootComponentStatus = "ready" | "degraded" | "unavailable";

export interface HealthSnapshot {
  status: DependencyHealthStatus;
  latencyMs: number;
  checkedAt: string;
  errorCode: string | null;
  retryable: boolean;
}

export interface HorizonHealthSnapshot extends HealthSnapshot {
  latestLedger?: number;
}

export interface SorobanRpcHealthSnapshot extends HealthSnapshot {
  networkPassphrase?: string;
}

export interface DatabaseHealthSnapshot extends HealthSnapshot {
  dbVersion?: string;
}

export interface IndexerHealthSnapshot extends HealthSnapshot {
  syncedLedger?: number;
  lagLedgers?: number;
}

export interface ReadinessResponse {
  status: "healthy" | "degraded" | "unavailable";
  dependencies: {
    horizon: HorizonHealthSnapshot;
    sorobanRpc: SorobanRpcHealthSnapshot;
    database: DatabaseHealthSnapshot;
    indexer: IndexerHealthSnapshot;
  };
  checkedAt: string;
}

/**
 * Structured boot summary for startup diagnostics.
 * Combines wallet, API, and indexer readiness at startup.
 */
export interface BootSummaryResponse {
  status: "ready" | "partial" | "failed";
  summary: string;
  components: {
    wallet: {
      status: BootComponentStatus;
      ready: boolean;
      reason?: string;
      capabilities?: {
        challengeGeneration: boolean;
        challengeVerification: boolean;
        replayProtection: boolean;
      };
    };
    api: {
      status: BootComponentStatus;
      ready: boolean;
      reason?: string;
      dependencies?: {
        database: BootComponentStatus;
        horizon: BootComponentStatus;
        sorobanRpc: BootComponentStatus;
      };
    };
    indexer: {
      status: BootComponentStatus;
      ready: boolean;
      reason?: string;
      details?: {
        syncedLedger?: number;
        lagLedgers?: number;
        recentErrorCount?: number;
      };
    };
  };
  checkedAt: string;
  recommendations: string[];
}
