/**
 * Service Dependency Graph Modeling & Analysis Engine (#1100)
 *
 * Models core system services and their directional dependencies as a graph.
 * Computes root-cause analysis (RCA), transitive blast radius, and effective
 * service degradation when upstream dependencies fail or experience latency/lag.
 */

import type {
  DatabaseSnapshot,
  HorizonSnapshot,
  SorobanRpcSnapshot,
  IndexerSnapshot,
  CacheSnapshot,
} from "../routes/health";

export type ServiceId =
  | "database"
  | "cache"
  | "horizon"
  | "sorobanRpc"
  | "indexer"
  | "queues"
  | "api";

export type ServiceCategory =
  | "datastore"
  | "cache"
  | "network"
  | "indexer"
  | "workers"
  | "gateway";

export type ServiceHealthStatus = "up" | "down" | "warning";
export type GraphOverallStatus = "healthy" | "degraded" | "outage";
export type EdgeHealthStatus = "healthy" | "degraded" | "broken";

export interface ServiceDependencyNode {
  id: ServiceId;
  name: string;
  category: ServiceCategory;
  description: string;
  status: ServiceHealthStatus;
  isDegraded: boolean;
  latencyMs?: number;
  errorCode?: string | null;
  retryable?: boolean;
  hint?: string;
  /** Direct upstream services this node requires */
  dependencies: ServiceId[];
  /** Direct downstream services that require this node */
  dependents: ServiceId[];
  /** Whether this service is critical to system operation */
  critical: boolean;
  /** Direct or transitive upstream root causes impacting this node */
  impactedBy: ServiceId[];
  /** Extra service-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface ServiceDependencyEdge {
  from: ServiceId; // Dependent service (e.g. indexer)
  to: ServiceId; // Required dependency (e.g. database)
  critical: boolean;
  status: EdgeHealthStatus;
  description: string;
}

export interface DependencyGraphSummary {
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  downServices: number;
  overallStatus: GraphOverallStatus;
  /** Services that are direct root causes of degradation/outage */
  rootCauses: ServiceId[];
  /** Downstream services impacted by the root causes */
  affectedServices: ServiceId[];
  /** Transitive mapping: rootCause -> array of all downstream affected service IDs */
  blastRadius: Record<ServiceId, ServiceId[]>;
}

export interface ServiceDependencyGraph {
  nodes: ServiceDependencyNode[];
  edges: ServiceDependencyEdge[];
  summary: DependencyGraphSummary;
  generatedAt: string;
}

export interface DependencySnapshotsInput {
  database?: Partial<DatabaseSnapshot>;
  horizon?: Partial<HorizonSnapshot>;
  sorobanRpc?: Partial<SorobanRpcSnapshot>;
  indexer?: Partial<IndexerSnapshot>;
  cache?: Partial<CacheSnapshot>;
  queues?: {
    status?: ServiceHealthStatus;
    latencyMs?: number;
    errorCode?: string | null;
    hint?: string;
    failedJobs?: number;
    delayedJobs?: number;
  };
  api?: {
    status?: ServiceHealthStatus;
    latencyMs?: number;
    errorCode?: string | null;
    hint?: string;
  };
}

// ── Graph Topology Definition ────────────────────────────────────────────────

interface ServiceTopologySpec {
  id: ServiceId;
  name: string;
  category: ServiceCategory;
  description: string;
  critical: boolean;
  dependencies: ServiceId[];
}

export const SERVICE_TOPOLOGY: readonly ServiceTopologySpec[] = [
  {
    id: "database",
    name: "PostgreSQL Database",
    category: "datastore",
    description: "Primary relational datastore for state, vaults, and event persistence",
    critical: true,
    dependencies: [],
  },
  {
    id: "cache",
    name: "Redis Cache & Queue Broker",
    category: "cache",
    description: "In-memory datastore for BullMQ queues and fast key-value cache",
    critical: true,
    dependencies: [],
  },
  {
    id: "horizon",
    name: "Stellar Horizon RPC",
    category: "network",
    description: "Stellar network Horizon endpoint for ledger querying and ingestion",
    critical: true,
    dependencies: [],
  },
  {
    id: "sorobanRpc",
    name: "Soroban RPC Endpoint",
    category: "network",
    description: "Soroban RPC node for smart contract invocation and simulation",
    critical: true,
    dependencies: [],
  },
  {
    id: "indexer",
    name: "Event & Ledger Indexer",
    category: "indexer",
    description: "Ingests on-chain contract events and ledger state into the database",
    critical: false,
    dependencies: ["database", "horizon", "sorobanRpc"],
  },
  {
    id: "queues",
    name: "Background Keepers & Queues",
    category: "workers",
    description: "BullMQ worker queues for rebalance, liquidation, and yield harvesting",
    critical: false,
    dependencies: ["cache", "database", "sorobanRpc"],
  },
  {
    id: "api",
    name: "Core API Gateway",
    category: "gateway",
    description: "StellarYield REST, GraphQL, and WebSocket API services",
    critical: true,
    dependencies: ["database", "cache", "horizon", "sorobanRpc", "indexer"],
  },
] as const;

export const DEPENDENCY_EDGES_SPEC: readonly {
  from: ServiceId;
  to: ServiceId;
  critical: boolean;
  description: string;
}[] = [
  {
    from: "indexer",
    to: "database",
    critical: true,
    description: "Indexer requires database write access to persist synced ledger state",
  },
  {
    from: "indexer",
    to: "horizon",
    critical: true,
    description: "Indexer requires Horizon to stream ledgers and transactions",
  },
  {
    from: "indexer",
    to: "sorobanRpc",
    critical: false,
    description: "Indexer queries Soroban RPC for contract state and event details",
  },
  {
    from: "queues",
    to: "cache",
    critical: true,
    description: "Background worker queues depend on Redis for job scheduling",
  },
  {
    from: "queues",
    to: "database",
    critical: true,
    description: "Workers query and persist position data in PostgreSQL",
  },
  {
    from: "queues",
    to: "sorobanRpc",
    critical: true,
    description: "Keeper workers execute contract transactions via Soroban RPC",
  },
  {
    from: "api",
    to: "database",
    critical: true,
    description: "API reads and writes user accounts, vaults, and positions",
  },
  {
    from: "api",
    to: "cache",
    critical: false,
    description: "API utilizes Redis for response caching and rate limiting",
  },
  {
    from: "api",
    to: "horizon",
    critical: true,
    description: "API queries account balances and submits fee-bumped transactions",
  },
  {
    from: "api",
    to: "sorobanRpc",
    critical: true,
    description: "API simulates smart contract calls and fetches live contract data",
  },
  {
    from: "api",
    to: "indexer",
    critical: false,
    description: "API serves indexed transaction history and event chronologies",
  },
];

// ── Graph Construction & Analysis ──────────────────────────────────────────

/**
 * Builds a comprehensive ServiceDependencyGraph from live component snapshots.
 * Determines root-cause failures, blast radius, and edge health.
 */
export function buildServiceDependencyGraph(
  input: DependencySnapshotsInput = {},
  now: number = Date.now(),
): ServiceDependencyGraph {
  const generatedAt = new Date(now).toISOString();

  // 1. Resolve raw statuses for each service node
  const dbSnap = input.database;
  const horSnap = input.horizon;
  const rpcSnap = input.sorobanRpc;
  const idxSnap = input.indexer;
  const cacheSnap = input.cache;
  const queuesInput = input.queues;
  const apiInput = input.api;

  const rawStatuses: Record<ServiceId, {
    status: ServiceHealthStatus;
    latencyMs?: number;
    errorCode?: string | null;
    retryable?: boolean;
    hint?: string;
    metadata?: Record<string, unknown>;
  }> = {
    database: {
      status: dbSnap?.status ?? "up",
      latencyMs: dbSnap?.latencyMs,
      errorCode: dbSnap?.errorCode ?? null,
      retryable: dbSnap?.retryable ?? false,
      hint: dbSnap?.hint,
    },
    cache: {
      status: cacheSnap?.status ?? "up",
      latencyMs: cacheSnap?.latencyMs,
      errorCode: cacheSnap?.errorCode ?? null,
      retryable: cacheSnap?.retryable ?? false,
      hint: cacheSnap?.hint,
    },
    horizon: {
      status: horSnap?.status ?? "up",
      latencyMs: horSnap?.latencyMs,
      errorCode: horSnap?.errorCode ?? null,
      retryable: horSnap?.retryable ?? false,
      hint: horSnap?.hint,
      metadata: horSnap?.latestLedger !== undefined ? { latestLedger: horSnap.latestLedger } : undefined,
    },
    sorobanRpc: {
      status: rpcSnap?.status ?? "up",
      latencyMs: rpcSnap?.latencyMs,
      errorCode: rpcSnap?.errorCode ?? null,
      retryable: rpcSnap?.retryable ?? false,
      hint: rpcSnap?.hint,
    },
    indexer: {
      status: idxSnap?.status ?? "up",
      latencyMs: idxSnap?.latencyMs,
      errorCode: idxSnap?.errorCode ?? null,
      retryable: idxSnap?.retryable ?? false,
      hint: idxSnap?.hint,
      metadata: {
        syncedLedger: idxSnap?.syncedLedger,
        lagLedgers: idxSnap?.lagLedgers,
      },
    },
    queues: {
      status: queuesInput?.status ?? (cacheSnap?.status === "down" ? "down" : "up"),
      latencyMs: queuesInput?.latencyMs,
      errorCode: queuesInput?.errorCode ?? (cacheSnap?.status === "down" ? "REDIS_UNAVAILABLE" : null),
      retryable: true,
      hint: queuesInput?.hint ?? (cacheSnap?.status === "down" ? "Workers halted due to Redis cache outage" : undefined),
      metadata: {
        failedJobs: queuesInput?.failedJobs ?? 0,
        delayedJobs: queuesInput?.delayedJobs ?? 0,
      },
    },
    api: {
      status: apiInput?.status ?? "up",
      latencyMs: apiInput?.latencyMs,
      errorCode: apiInput?.errorCode ?? null,
      retryable: true,
      hint: apiInput?.hint,
    },
  };

  // Build dependents map from topology
  const dependentsMap = new Map<ServiceId, ServiceId[]>();
  for (const spec of SERVICE_TOPOLOGY) {
    dependentsMap.set(spec.id, []);
  }
  for (const edge of DEPENDENCY_EDGES_SPEC) {
    const list = dependentsMap.get(edge.to) ?? [];
    if (!list.includes(edge.from)) {
      list.push(edge.from);
      dependentsMap.set(edge.to, list);
    }
  }

  // 2. Identify primary Root Causes
  // A root cause is a service that is down or warning on its own accord (e.g. its own check failed)
  const rootCauses: ServiceId[] = [];
  for (const spec of SERVICE_TOPOLOGY) {
    const nodeState = rawStatuses[spec.id];
    if (nodeState.status === "down" || nodeState.status === "warning") {
      // Check if this service's degradation is caused by an upstream dependency
      const hasUpstreamDown = spec.dependencies.some(
        (depId) => rawStatuses[depId]?.status === "down",
      );
      if (!hasUpstreamDown || spec.dependencies.length === 0) {
        rootCauses.push(spec.id);
      }
    }
  }

  // 3. Compute Transitive Blast Radius for each Root Cause
  const blastRadius: Record<ServiceId, ServiceId[]> = {
    database: [],
    cache: [],
    horizon: [],
    sorobanRpc: [],
    indexer: [],
    queues: [],
    api: [],
  };

  for (const rootId of rootCauses) {
    const visited = new Set<ServiceId>();
    const queue: ServiceId[] = [...(dependentsMap.get(rootId) ?? [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (!visited.has(current)) {
        visited.add(current);
        const nextDependents = dependentsMap.get(current) ?? [];
        for (const dep of nextDependents) {
          if (!visited.has(dep)) {
            queue.push(dep);
          }
        }
      }
    }
    blastRadius[rootId] = Array.from(visited);
  }

  // Compute impactedBy for each node
  const impactedByMap = new Map<ServiceId, Set<ServiceId>>();
  for (const spec of SERVICE_TOPOLOGY) {
    impactedByMap.set(spec.id, new Set<ServiceId>());
  }
  for (const rootId of rootCauses) {
    const affected = blastRadius[rootId] ?? [];
    for (const affId of affected) {
      impactedByMap.get(affId)?.add(rootId);
    }
  }

  // 4. Construct Nodes
  const nodes: ServiceDependencyNode[] = SERVICE_TOPOLOGY.map((spec) => {
    const raw = rawStatuses[spec.id];
    const impactedBy = Array.from(impactedByMap.get(spec.id) ?? []);
    const isDirectlyDegraded = raw.status === "down" || raw.status === "warning";
    const isTransitivelyImpacted = impactedBy.length > 0;
    const isDegraded = isDirectlyDegraded || isTransitivelyImpacted;

    // If an upstream critical dependency is down, propagate degraded status if not already down
    let effectiveStatus = raw.status;
    if (effectiveStatus === "up" && isTransitivelyImpacted) {
      const hasDownRootCause = impactedBy.some((rc) => rawStatuses[rc]?.status === "down");
      effectiveStatus = hasDownRootCause ? "warning" : "warning";
    }

    return {
      id: spec.id,
      name: spec.name,
      category: spec.category,
      description: spec.description,
      status: effectiveStatus,
      isDegraded,
      latencyMs: raw.latencyMs,
      errorCode: raw.errorCode,
      retryable: raw.retryable,
      hint: raw.hint,
      dependencies: [...spec.dependencies],
      dependents: [...(dependentsMap.get(spec.id) ?? [])],
      critical: spec.critical,
      impactedBy,
      metadata: raw.metadata,
    };
  });

  // 5. Construct Edges
  const edges: ServiceDependencyEdge[] = DEPENDENCY_EDGES_SPEC.map((spec) => {
    const targetStatus = rawStatuses[spec.to]?.status ?? "up";
    let edgeStatus: EdgeHealthStatus = "healthy";
    if (targetStatus === "down") {
      edgeStatus = "broken";
    } else if (targetStatus === "warning") {
      edgeStatus = "degraded";
    }

    return {
      from: spec.from,
      to: spec.to,
      critical: spec.critical,
      status: edgeStatus,
      description: spec.description,
    };
  });

  // 6. Compute Summary
  const downServices = nodes.filter((n) => n.status === "down").length;
  const degradedServices = nodes.filter((n) => n.status === "warning").length;
  const healthyServices = nodes.filter((n) => n.status === "up").length;

  const affectedServicesSet = new Set<ServiceId>();
  for (const rootId of rootCauses) {
    for (const affId of blastRadius[rootId] ?? []) {
      affectedServicesSet.add(affId);
    }
  }

  const overallStatus: GraphOverallStatus =
    downServices > 0
      ? "outage"
      : degradedServices > 0
        ? "degraded"
        : "healthy";

  const summary: DependencyGraphSummary = {
    totalServices: nodes.length,
    healthyServices,
    degradedServices,
    downServices,
    overallStatus,
    rootCauses,
    affectedServices: Array.from(affectedServicesSet),
    blastRadius,
  };

  return {
    nodes,
    edges,
    summary,
    generatedAt,
  };
}
