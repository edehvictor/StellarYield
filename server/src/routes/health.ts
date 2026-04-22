import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { Horizon } from "@stellar/stellar-sdk";

const router = Router();
const prisma = new PrismaClient();
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

type HealthStatus = {
  database: "up" | "down";
  redis: "up";
  indexer: "up" | "down" | "warning";
  horizon: "up" | "down";
  timestamp: string;
  latestLedger?: number;
  syncedLedger?: number;
};

/**
 * @notice Check the health of the system.
 * @dev Checks DB connection, indexer latency, and Stellar Horizon availability.
 */
router.get("/", async (_req: Request, res: Response) => {
  const status: HealthStatus = {
    database: "down",
    redis: "up", // Mocked as up
    indexer: "down",
    horizon: "down",
    timestamp: new Date().toISOString(),
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    status.database = "up";
  } catch {
    status.database = "down";
  }

  try {
    const state = await prisma.indexerState.findFirst();
    const latestLedger = await horizon.ledgers().limit(1).order("desc").call();
    const horizonLedger = latestLedger.records[0].sequence;
    
    status.horizon = "up";
    status.latestLedger = horizonLedger;
    status.syncedLedger = state?.lastLedger || 0;

    if (horizonLedger - (state?.lastLedger || 0) < 50) {
      status.indexer = "up";
    } else {
      status.indexer = "warning";
    }
  } catch {
    status.horizon = "down";
  }

  const isHealthy = Object.values(status).every(v => v !== "down");
  res.status(isHealthy ? 200 : 503).json(status);
});

export default router;
