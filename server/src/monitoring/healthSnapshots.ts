export type DependencyHealthStatus =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "misconfigured";

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
