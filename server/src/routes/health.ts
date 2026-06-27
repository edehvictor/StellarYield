import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { Horizon, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { validateServerEnv } from "../config/env";

const router = Router();
const prisma = new PrismaClient();

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? "5000");
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

  res.status(isHealthy ? 200 : 503).json(body);
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

export interface DependencyDetail {
  status: DependencyStatus;
  latencyMs?: number;
  hint?: string;
}

export interface DependenciesResponse {
  database: DependencyDetail;
  horizon: DependencyDetail & { latestLedger?: number };
  indexer: DependencyDetail & { syncedLedger?: number; lagLedgers?: number };
  cache: DependencyDetail;
  timestamp: string;
  overallStatus: DependencyStatus;
}

async function checkDatabaseWithLatency(): Promise<DependencyDetail> {
  const start = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, HEALTH_TIMEOUT_MS);
    return { status: "up", latencyMs: Date.now() - start };
  } catch {
    return { status: "down", hint: "Database unreachable — check DATABASE_URL and Postgres availability" };
  }
}

async function checkHorizonWithLatency(): Promise<DependencyDetail & { latestLedger?: number }> {
  const start = Date.now();
  try {
    const horizon = new Horizon.Server(HORIZON_URL);
    const resp = await withTimeout(
      horizon.ledgers().limit(1).order("desc").call(),
      HEALTH_TIMEOUT_MS,
    );
    return {
      status: "up",
      latencyMs: Date.now() - start,
      latestLedger: resp.records[0]?.sequence,
    };
  } catch {
    return {
      status: "down",
      hint: "Horizon unreachable — check STELLAR_HORIZON_URL or network connectivity",
    };
  }
}

async function checkIndexerWithLatency(
  latestLedger?: number,
): Promise<DependencyDetail & { syncedLedger?: number; lagLedgers?: number }> {
  const start = Date.now();
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
        syncedLedger,
        lagLedgers,
        hint: `Indexer is ${lagLedgers} ledgers behind — may indicate a stalled indexer process`,
      };
    }
    return { status: "up", latencyMs, syncedLedger, lagLedgers };
  } catch {
    return {
      status: "down",
      hint: "Indexer state unavailable — check database connectivity and indexer process",
    };
  }
}

async function checkCacheWithLatency(): Promise<DependencyDetail> {
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  const start = Date.now();
  try {
    await withTimeout(redis.ping(), HEALTH_TIMEOUT_MS);
    return { status: "up", latencyMs: Date.now() - start };
  } catch {
    return {
      status: "down",
      hint: "Redis unreachable — check REDIS_URL and Redis availability",
    };
  } finally {
    await redis.quit().catch(() => {});
  }
}

/**
 * GET /health/dependencies
 *
 * Returns a per-dependency breakdown of database, Horizon, indexer, and cache
 * health. Includes safe latency hints where available. Never exposes credentials
 * or private user data.
 */
router.get("/dependencies", async (_req: Request, res: Response) => {
  const [database, horizon] = await Promise.all([
    checkDatabaseWithLatency(),
    checkHorizonWithLatency(),
  ]);

  const [indexer, cache] = await Promise.all([
    checkIndexerWithLatency(horizon.latestLedger),
    checkCacheWithLatency(),
  ]);

  const statuses: DependencyStatus[] = [
    database.status,
    horizon.status,
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
    indexer,
    cache,
    timestamp: new Date().toISOString(),
    overallStatus,
  };

  res.status(overallStatus === "down" ? 503 : 200).json(body);
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
