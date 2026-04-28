import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { Horizon, rpc as SorobanRpc } from "@stellar/stellar-sdk";

const router = Router();
const prisma = new PrismaClient();

const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? "5000");
const _INDEXER_LAG_WARN_THRESHOLD = Number(process.env.INDEXER_LAG_WARN_LEDGERS ?? "50");

type ComponentStatus = "up" | "down" | "warning";

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

export default router;
