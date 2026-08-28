import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { Horizon, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { validateServerEnv } from "../config/env";
import type {
  DependencyHealthStatus,
  HorizonHealthSnapshot,
  SorobanRpcHealthSnapshot,
  DatabaseHealthSnapshot,
  IndexerHealthSnapshot,
  ReadinessResponse as DeploymentReadinessResponse,
} from "../monitoring/healthSnapshots";

const router = Router();
const prisma = new PrismaClient();

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const HEALTH_TIMEOUT_MS =
  process.env.NODE_ENV === "test"
    ? 500
    : Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? "5000");
const _INDEXER_LAG_WARN_THRESHOLD = Number(process.env.INDEXER_LAG_WARN_LEDGERS ?? "50");
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const QUEUE_FAILED_THRESHOLD = Number(process.env.QUEUE_FAILED_THRESHOLD ?? "10");
const QUEUE_DELAYED_THRESHOLD = Number(process.env.QUEUE_DELAYED_THRESHOLD ?? "50");

const ALL_QUEUE_NAMES = [
  "liquidation",
  "compound",
  "digest-generation",
  "digest-threshold-check",
  "rebalance-execution",
  "rebalance-retry",
];

type ComponentStatus = "up" | "down" | "warning";
type QueueStatus = "healthy" | "warning" | "error";

export interface QueueJobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface QueueHealthEntry {
  name: string;
  counts: QueueJobCounts;
  status: QueueStatus;
  warnings: string[];
}

export interface QueueHealthSummary {
  queues: QueueHealthEntry[];
  overallStatus: QueueStatus;
  timestamp: string;
}

export type HealthStatus = {
  database: ComponentStatus;
  horizon: ComponentStatus;
  sorobanRpc: ComponentStatus;
  indexer: ComponentStatus;
  timestamp: string;
  latestLedger?: number;
  syncedLedger?: number;
  indexerLag?: number;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

async function checkDatabase(): Promise<ComponentStatus> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_TIMEOUT_MS);
    return "up";
  } catch {
    return "down";
  }
}

async function checkHorizon(): Promise<{
  status: ComponentStatus;
  latestLedger?: number;
}> {
  try {
    const horizon = new Horizon.Server(HORIZON_URL);
    const resp = await withTimeout(
      horizon.ledgers().limit(1).order("desc").call(),
      HEALTH_TIMEOUT_MS,
    );
    return { status: "up", latestLedger: resp.records[0]?.sequence };
  } catch {
    return { status: "down" };
  }
}

async function checkSorobanRpc(): Promise<ComponentStatus> {
  try {
    const server = new SorobanRpc.Server(SOROBAN_RPC_URL);
    await withTimeout(server.getNetwork(), HEALTH_TIMEOUT_MS);
    return "up";
  } catch {
    return "down";
  }
}

async function checkIndexer(
  _latestLedger?: number,
): Promise<{
  status: ComponentStatus;
  syncedLedger?: number;
  lag?: number;
}> {
  try {
    const state = await prisma.indexerState.findFirst();
    const syncedLedger = state?.lastLedger ?? 0;
    const lag = _latestLedger ? _latestLedger - syncedLedger : undefined;

    if (!lag || lag < 50) {
      return { status: "up", syncedLedger, lag };
    } else {
      return { status: "warning", syncedLedger, lag };
    }
  } catch {
    return { status: "down" };
  }
}

router.get("/", async (_req: Request, res: Response) => {
  const [dbStatus, horizonResult, rpcStatus] = await Promise.all([
    checkDatabase(),
    checkHorizon(),
    checkSorobanRpc(),
  ]);

  const indexerResult = await checkIndexer(horizonResult.latestLedger);

  const body: HealthStatus = {
    database: dbStatus,
    horizon: horizonResult.status,
    sorobanRpc: rpcStatus,
    indexer: indexerResult.status,
    timestamp: new Date().toISOString(),
    latestLedger: horizonResult.latestLedger,
    syncedLedger: indexerResult.syncedLedger,
    indexerLag: indexerResult.lag,
  };

  const isHealthy = (
    ["database", "horizon", "sorobanRpc", "indexer"] as const
  ).every((k) => body[k] !== "down");

  const status = isHealthy ? "healthy" : "degraded";
  res.status(isHealthy ? 200 : 503).json({ ...body, status, ok: isHealthy });
});

router.get("/queues", async (_req: Request, res: Response) => {
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  try {
    const entries: QueueHealthEntry[] = await Promise.all(
      ALL_QUEUE_NAMES.map(async (name): Promise<QueueHealthEntry> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const queue = new Queue(name, { connection: redis as any });
        try {
          const raw = await withTimeout(
            queue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
            HEALTH_TIMEOUT_MS,
          );
          const counts: QueueJobCounts = {
            waiting: raw.waiting ?? 0,
            active: raw.active ?? 0,
            completed: raw.completed ?? 0,
            failed: raw.failed ?? 0,
            delayed: raw.delayed ?? 0,
          };
          const warnings: string[] = [];
          if (counts.failed > QUEUE_FAILED_THRESHOLD) {
            warnings.push(
              `failed jobs (${counts.failed}) exceed threshold (${QUEUE_FAILED_THRESHOLD})`,
            );
          }
          if (counts.delayed > QUEUE_DELAYED_THRESHOLD) {
            warnings.push(
              `delayed jobs (${counts.delayed}) exceed threshold (${QUEUE_DELAYED_THRESHOLD})`,
            );
          }
          return {
            name,
            counts,
            status: warnings.length > 0 ? "warning" : "healthy",
            warnings,
          };
        } catch {
          return {
            name,
            counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
            status: "error",
            warnings: ["failed to fetch job counts"],
          };
        } finally {
          await queue.close();
        }
      }),
    );

    const overallStatus: QueueStatus = entries.some((e) => e.status === "error")
      ? "error"
      : entries.some((e) => e.status === "warning")
        ? "warning"
        : "healthy";

    const body: QueueHealthSummary = { queues: entries, overallStatus, timestamp: new Date().toISOString() };
    res.status(overallStatus === "error" ? 503 : 200).json(body);
  } finally {
    await redis.quit().catch(() => {});
  }
});

export type DependencyStatus = "up" | "down" | "warning";

/**
 * Typed health snapshot for a single dependency.
 * Includes latency, checkedAt timestamp, error code, and retryable flag
 * so operators can distinguish transient failures from permanent ones.
 */
export interface HealthSnapshot {
  status: DependencyStatus;
  latencyMs?: number;
  checkedAt: string;
  errorCode: string | null;
  retryable: boolean;
  hint?: string;
}

export interface DatabaseSnapshot extends HealthSnapshot {}

export interface HorizonSnapshot extends HealthSnapshot {
  latestLedger?: number;
}

export interface SorobanRpcSnapshot extends HealthSnapshot {}

export interface IndexerSnapshot extends HealthSnapshot {
  syncedLedger?: number;
  lagLedgers?: number;
}

export interface CacheSnapshot extends HealthSnapshot {}

export interface DependenciesResponse {
  database: DatabaseSnapshot;
  horizon: HorizonSnapshot;
  sorobanRpc: SorobanRpcSnapshot;
  indexer: IndexerSnapshot;
  cache: CacheSnapshot;
  timestamp: string;
  overallStatus: DependencyStatus;
}

/**
 * Readiness probe — a lightweight summary of the combined dependency health
 * intended for deployment smoke tests and load-balancer health checks.
 */
export interface ReadinessResponse {
  status: "ready" | "degraded" | "unavailable";
  dependencies: {
    database: DependencyStatus;
    horizon: DependencyStatus;
    sorobanRpc: DependencyStatus;
    indexer: DependencyStatus;
    cache: DependencyStatus;
  };
  latencyMs: number;
  checkedAt: string;
}

async function checkDatabaseWithLatency(): Promise<DatabaseSnapshot> {
  const start = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_TIMEOUT_MS);
    return {
      status: "up",
      latencyMs: Date.now() - start,
      checkedAt,
      errorCode: null,
      retryable: false,
    };
  } catch {
    return {
      status: "down",
      checkedAt,
      errorCode: "DB_UNREACHABLE",
      retryable: true,
      hint: "Database unreachable — check DATABASE_URL and Postgres availability",
    };
  }
}

async function checkHorizonWithLatency(): Promise<HorizonSnapshot> {
  const start = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const horizon = new Horizon.Server(HORIZON_URL);
    const resp = await withTimeout(
      horizon.ledgers().limit(1).order("desc").call(),
      HEALTH_TIMEOUT_MS,
    );
    return {
      status: "up",
      latencyMs: Date.now() - start,
      checkedAt,
      errorCode: null,
      retryable: false,
      latestLedger: resp.records[0]?.sequence,
    };
  } catch {
    return {
      status: "down",
      checkedAt,
      errorCode: "HORIZON_UNREACHABLE",
      retryable: true,
      hint: "Horizon unreachable — check STELLAR_HORIZON_URL or network connectivity",
    };
  }
}

async function checkIndexerWithLatency(
  latestLedger?: number,
): Promise<IndexerSnapshot> {
  const start = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const state = await withTimeout(
      prisma.indexerState.findFirst(),
      HEALTH_TIMEOUT_MS,
    );
    const syncedLedger = state?.lastLedger ?? 0;
    const lagLedgers = latestLedger ? latestLedger - syncedLedger : undefined;
    const latencyMs = Date.now() - start;

    if (lagLedgers !== undefined && lagLedgers >= 50) {
      return {
        status: "warning",
        latencyMs,
        checkedAt,
        errorCode: "INDEXER_LAG",
        retryable: true,
        syncedLedger,
        lagLedgers,
        hint: `Indexer is ${lagLedgers} ledgers behind — may indicate a stalled indexer process`,
      };
    }
    return { status: "up", latencyMs, checkedAt, errorCode: null, retryable: false, syncedLedger, lagLedgers };
  } catch {
    return {
      status: "down",
      checkedAt,
      errorCode: "INDEXER_STATE_UNAVAILABLE",
      retryable: true,
      hint: "Indexer state unavailable — check database connectivity and indexer process",
    };
  }
}

async function checkSorobanRpcWithLatency(): Promise<SorobanRpcSnapshot> {
  const start = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const server = new SorobanRpc.Server(SOROBAN_RPC_URL);
    await withTimeout(server.getNetwork(), HEALTH_TIMEOUT_MS);
    return {
      status: "up",
      latencyMs: Date.now() - start,
      checkedAt,
      errorCode: null,
      retryable: false,
    };
  } catch {
    return {
      status: "down",
      checkedAt,
      errorCode: "RPC_UNREACHABLE",
      retryable: true,
      hint: "Soroban RPC unreachable — check SOROBAN_RPC_URL and network connectivity",
    };
  }
}

async function checkCacheWithLatency(): Promise<CacheSnapshot> {
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  const start = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    await withTimeout(redis.ping(), HEALTH_TIMEOUT_MS);
    return {
      status: "up",
      latencyMs: Date.now() - start,
      checkedAt,
      errorCode: null,
      retryable: false,
    };
  } catch {
    return {
      status: "down",
      checkedAt,
      errorCode: "CACHE_UNREACHABLE",
      retryable: true,
      hint: "Redis unreachable — check REDIS_URL and Redis availability",
    };
  } finally {
    await redis.quit().catch(() => {});
  }
}

/**
 * GET /health/dependencies
 *
 * Returns a per-dependency typed health snapshot for database, Horizon,
 * Soroban RPC, indexer, and cache. Each entry includes latency, checkedAt
 * timestamp, error code, and retryable flag so operators can distinguish
 * transient failures from permanent ones.
 */
router.get("/dependencies", async (_req: Request, res: Response) => {
  const [database, horizon, sorobanRpc] = await Promise.all([
    checkDatabaseWithLatency(),
    checkHorizonWithLatency(),
    checkSorobanRpcWithLatency(),
  ]);

  const [indexer, cache] = await Promise.all([
    checkIndexerWithLatency(horizon.latestLedger),
    checkCacheWithLatency(),
  ]);

  const statuses: DependencyStatus[] = [
    database.status,
    horizon.status,
    sorobanRpc.status,
    indexer.status,
    cache.status,
  ];

  const overallStatus: DependencyStatus = statuses.includes("down")
    ? "down"
    : statuses.includes("warning")
      ? "warning"
      : "up";

  const body: DependenciesResponse = {
    database,
    horizon,
    sorobanRpc,
    indexer,
    cache,
    timestamp: new Date().toISOString(),
    overallStatus,
  };

  res.status(overallStatus === "down" ? 503 : 200).json(body);
});

// ── Typed snapshot helpers ────────────────────────────────────────────────

const DEGRADED_LATENCY_MS = Math.round(HEALTH_TIMEOUT_MS * 0.6);

async function checkHorizonSnapshot(): Promise<HorizonHealthSnapshot> {
  const start = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const horizon = new Horizon.Server(HORIZON_URL);
    const resp = await withTimeout(
      horizon.ledgers().limit(1).order("desc").call(),
      HEALTH_TIMEOUT_MS,
    );
    const latencyMs = Date.now() - start;
    return {
      status: latencyMs > DEGRADED_LATENCY_MS ? "degraded" : "healthy",
      latencyMs,
      checkedAt,
      latestLedger: resp.records[0]?.sequence,
      errorCode: latencyMs > DEGRADED_LATENCY_MS ? "HORIZON_SLOW" : null,
      retryable: latencyMs > DEGRADED_LATENCY_MS,
    };
  } catch {
    return {
      status: "unavailable",
      latencyMs: Date.now() - start,
      checkedAt,
      errorCode: "HORIZON_UNREACHABLE",
      retryable: true,
    };
  }
}

async function checkSorobanRpcSnapshot(): Promise<SorobanRpcHealthSnapshot> {
  const start = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const server = new SorobanRpc.Server(SOROBAN_RPC_URL);
    const network = await withTimeout(server.getNetwork(), HEALTH_TIMEOUT_MS);
    const latencyMs = Date.now() - start;
    return {
      status: latencyMs > DEGRADED_LATENCY_MS ? "degraded" : "healthy",
      latencyMs,
      checkedAt,
      networkPassphrase: network.passphrase,
      errorCode: latencyMs > DEGRADED_LATENCY_MS ? "SOROBAN_RPC_SLOW" : null,
      retryable: latencyMs > DEGRADED_LATENCY_MS,
    };
  } catch {
    return {
      status: "unavailable",
      latencyMs: Date.now() - start,
      checkedAt,
      errorCode: "SOROBAN_RPC_UNREACHABLE",
      retryable: true,
    };
  }
}

async function checkDatabaseSnapshot(): Promise<DatabaseHealthSnapshot> {
  const start = Date.now();
  const checkedAt = new Date().toISOString();

  if (!process.env.DATABASE_URL) {
    return {
      status: "misconfigured",
      latencyMs: 0,
      checkedAt,
      errorCode: "DB_MISCONFIGURED",
      retryable: false,
    };
  }

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_TIMEOUT_MS);
    const latencyMs = Date.now() - start;
    return {
      status: latencyMs > DEGRADED_LATENCY_MS ? "degraded" : "healthy",
      latencyMs,
      checkedAt,
      errorCode: latencyMs > DEGRADED_LATENCY_MS ? "DB_SLOW" : null,
      retryable: latencyMs > DEGRADED_LATENCY_MS,
    };
  } catch {
    return {
      status: "unavailable",
      latencyMs: Date.now() - start,
      checkedAt,
      errorCode: "DB_UNREACHABLE",
      retryable: true,
    };
  }
}

async function checkIndexerSnapshot(
  latestLedger?: number,
): Promise<IndexerHealthSnapshot> {
  const start = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const state = await withTimeout(
      prisma.indexerState.findFirst(),
      HEALTH_TIMEOUT_MS,
    );
    const syncedLedger = state?.lastLedger ?? 0;
    const lagLedgers = latestLedger !== undefined && latestLedger !== 0
      ? Math.max(0, latestLedger - syncedLedger)
      : undefined;

    if (lagLedgers !== undefined && lagLedgers >= 720) {
      return {
        status: "unavailable",
        latencyMs: Date.now() - start,
        checkedAt,
        syncedLedger,
        lagLedgers,
        errorCode: "INDEXER_LAG_EXCESSIVE",
        retryable: true,
      };
    }
    if (lagLedgers !== undefined && lagLedgers >= 50) {
      return {
        status: "degraded",
        latencyMs: Date.now() - start,
        checkedAt,
        syncedLedger,
        lagLedgers,
        errorCode: "INDEXER_LAG_ELEVATED",
        retryable: true,
      };
    }
    return {
      status: "healthy",
      latencyMs: Date.now() - start,
      checkedAt,
      syncedLedger,
      lagLedgers,
      errorCode: null,
      retryable: false,
    };
  } catch {
    return {
      status: "unavailable",
      latencyMs: Date.now() - start,
      checkedAt,
      errorCode: "INDEXER_STATE_UNREADABLE",
      retryable: true,
    };
  }
}

/**
 * GET /health/readiness
 *
 * Combined readiness endpoint for deployment smoke tests. Returns typed health
 * snapshots for each dependency with latency, checkedAt, errorCode, and
 * retryable flag.  Returns 503 if any dependency is unavailable.
 */
router.get("/readiness", async (_req: Request, res: Response) => {
  const [horizon, sorobanRpc, database] = await Promise.all([
    checkHorizonSnapshot(),
    checkSorobanRpcSnapshot(),
    checkDatabaseSnapshot(),
  ]);

  const indexer = await checkIndexerSnapshot(horizon.latestLedger);

  const deps = { horizon, sorobanRpc, database, indexer };
  const statuses: DependencyHealthStatus[] = [
    deps.horizon.status,
    deps.sorobanRpc.status,
    deps.database.status,
    deps.indexer.status,
  ];

  const overallStatus: DeploymentReadinessResponse["status"] = statuses.includes("unavailable")
    ? "unavailable"
    : statuses.includes("degraded")
      ? "degraded"
      : "healthy";

  const body: DeploymentReadinessResponse = {
    status: overallStatus,
    dependencies: deps,
    checkedAt: new Date().toISOString(),
  };

  res.status(overallStatus === "unavailable" ? 503 : 200).json(body);
});

/**
 * GET /health/readiness
 *
 * Lightweight readiness probe returning a single combined status and
 * per-dependency summary. Designed for deployment smoke tests and
 * load-balancer health checks. Returns quickly by checking each
 * dependency with the standard timeout.
 */
router.get("/readiness", async (_req: Request, res: Response) => {
  const overallStart = Date.now();

  const [database, horizon, sorobanRpc] = await Promise.all([
    checkDatabaseWithLatency(),
    checkHorizonWithLatency(),
    checkSorobanRpcWithLatency(),
  ]);

  const [indexer, cache] = await Promise.all([
    checkIndexerWithLatency(horizon.latestLedger),
    checkCacheWithLatency(),
  ]);

  const deps = { database: database.status, horizon: horizon.status, sorobanRpc: sorobanRpc.status, indexer: indexer.status, cache: cache.status };
  const statusValues = Object.values(deps);

  let readiness: ReadinessResponse["status"] = "ready";
  if (statusValues.includes("down")) {
    readiness = "unavailable";
  } else if (statusValues.includes("warning")) {
    readiness = "degraded";
  }

  const body: ReadinessResponse = {
    status: readiness,
    dependencies: deps,
    latencyMs: Date.now() - overallStart,
    checkedAt: new Date().toISOString(),
  };

  res.status(readiness === "unavailable" ? 503 : 200).json(body);
});

/**
 * GET /health/startup
 *
 * Exposes a startup health summary backing environment validation checks without leaking credentials.
 */
router.get("/startup", async (_req: Request, res: Response) => {
  const env = process.env;
  const validation = validateServerEnv(env);

  const hasValue = (val: string | undefined): boolean =>
    typeof val === "string" && val.trim().length > 0;

  const capabilities = {
    database: hasValue(env.DATABASE_URL) ? "operational" : "disabled",
    mongodb: hasValue(env.MONGODB_URI) ? "operational" : "disabled",
    feeBumpRelayer: (hasValue(env.RELAYER_SECRET_KEY) && env.RELAYER_SECRET_KEY !== "SAH2...") ? "operational" : "disabled",
    zapQuoting: (hasValue(env.DEX_ROUTER_CONTRACT_ID) && hasValue(env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT)) ? "operational" : "disabled",
    sorobanRpc: hasValue(env.SOROBAN_RPC_URL) ? "operational" : "fallback",
    horizonRpc: hasValue(env.STELLAR_HORIZON_URL) ? "operational" : "fallback",
  };

  const status = validation.errors.length > 0
    ? "failed"
    : validation.warnings.length > 0
      ? "degraded"
      : "healthy";

  const body = {
    status,
    capabilities,
    errors: validation.errors,
    warnings: validation.warnings,
    timestamp: new Date().toISOString(),
  };

  res.status(status === "failed" ? 503 : 200).json(body);
});

export default router;
