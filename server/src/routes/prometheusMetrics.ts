/**
 * GET /metrics
 *
 * Prometheus-compatible scrape endpoint.
 * Returns metrics in Prometheus text exposition format (Content-Type: text/plain).
 *
 * Security:
 *  - Protected by METRICS_TOKEN env var (Bearer or x-metrics-token header).
 *  - In production, returns 404 when no token is configured (security by obscurity).
 *  - No user-specific data or wallet addresses are included in the output.
 */

import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { PrismaClient } from "@prisma/client";
import { Horizon } from "@stellar/stellar-sdk";
import { collectMetrics, prometheusRegistry } from "../monitoring/prometheus";

const router = Router();
const prisma = new PrismaClient();
const horizon = new Horizon.Server(
  process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
);

/**
 * Rate limiter for the /metrics scrape endpoint.
 * Prometheus scrapes every 15–60 s by default; 10 req/min is generous
 * while still blocking brute-force token enumeration.
 */
const metricsRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Return 429 (not 404) so Prometheus can distinguish rate-limit from auth failure
  message: "Too many requests",
});

function isAuthorized(req: Request): boolean {
  const token = process.env.METRICS_TOKEN;
  const nodeEnv = process.env.NODE_ENV;

  if (nodeEnv === "production" && !token) return false;
  if (!token) return true;

  const headerToken =
    (req.get("x-metrics-token") ?? "").trim() ||
    (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  return headerToken.length > 0 && headerToken === token;
}

/**
 * Scrape infrastructure state needed to populate gauges.
 * Returns safe defaults on failure so the scrape never hard-errors.
 */
async function gatherInfraState(): Promise<{
  dbUp: boolean;
  indexerLag: number;
  depositorCount: number;
}> {
  let dbUp = false;
  let indexerLag = 0;
  let depositorCount = 0;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }

  try {
    const [state, ledgerPage] = await Promise.all([
      prisma.indexerState.findFirst(),
      horizon.ledgers().limit(1).order("desc").call(),
    ]);
    const tip = ledgerPage.records[0]?.sequence ?? 0;
    indexerLag = Math.max(0, tip - (state?.lastLedger ?? 0));
  } catch {
    indexerLag = -1; // -1 signals "unknown" to Grafana dashboards
  }

  try {
    depositorCount = await prisma.vaultBalance.count();
  } catch {
    depositorCount = 0;
  }

  return { dbUp, indexerLag, depositorCount };
}

router.get("/", metricsRateLimit, async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(404).end();
    return;
  }

  try {
    const infra = await gatherInfraState();
    const payload = await collectMetrics(infra);
    res.set("Content-Type", prometheusRegistry.contentType);
    res.end(payload);
  } catch (err) {
    console.error("[prometheus] scrape failed", err);
    res.status(500).end();
  }
});

export default router;
