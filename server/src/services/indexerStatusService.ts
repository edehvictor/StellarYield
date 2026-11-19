/**
 * Indexer Status Service (#1100)
 *
 * Provides indexer replay checkpoint evaluation, lag monitoring, and
 * typed health snapshots for dependency graph integration.
 */

import { PrismaClient } from "@prisma/client";
import * as StellarSdk from "@stellar/stellar-sdk";
import type { IndexerSnapshot, DependencyStatus } from "../routes/health";

const prisma = new PrismaClient();
const HORIZON_URL = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const HEALTH_TIMEOUT_MS = process.env.NODE_ENV === "test" ? 500 : Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? "5000");

export interface IndexerEvaluationResult {
  status: DependencyStatus;
  syncedLedger?: number;
  latestLedger?: number;
  lagLedgers?: number;
  latencyMs: number;
  errorCode: string | null;
  retryable: boolean;
  hint?: string;
  checkedAt: string;
}

export async function evaluateIndexerStatus(latestLedger?: number): Promise<IndexerSnapshot> {
  const start = Date.now();
  const checkedAt = new Date().toISOString();

  try {
    const state = await Promise.race([
      prisma.indexerState.findFirst(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS)),
    ]);

    const syncedLedger = state?.lastLedger ?? 0;
    const latencyMs = Date.now() - start;

    let targetLatest = latestLedger;
    if (targetLatest === undefined) {
      try {
        const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
        const resp = await Promise.race([
          horizon.ledgers().limit(1).order("desc").call(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS)),
        ]);
        targetLatest = resp.records[0]?.sequence;
      } catch {
        // Fallback if horizon is unreachable during separate indexer check
      }
    }

    const lagLedgers = targetLatest !== undefined ? Math.max(0, targetLatest - syncedLedger) : undefined;

    if (lagLedgers !== undefined && lagLedgers >= 720) {
      return {
        status: "down",
        latencyMs,
        checkedAt,
        syncedLedger,
        lagLedgers,
        errorCode: "INDEXER_LAG_CRITICAL",
        retryable: true,
        hint: `Indexer is severely stalled (${lagLedgers} ledgers behind). Immediate operator attention required.`,
      };
    }

    if (lagLedgers !== undefined && lagLedgers >= 50) {
      return {
        status: "warning",
        latencyMs,
        checkedAt,
        syncedLedger,
        lagLedgers,
        errorCode: "INDEXER_LAG",
        retryable: true,
        hint: `Indexer is ${lagLedgers} ledgers behind — may indicate a slow or delayed indexer process`,
      };
    }

    return {
      status: "up",
      latencyMs,
      checkedAt,
      syncedLedger,
      lagLedgers,
      errorCode: null,
      retryable: false,
    };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      checkedAt,
      errorCode: "INDEXER_STATE_UNAVAILABLE",
      retryable: true,
      hint: "Indexer state unavailable — check database connectivity and indexer process",
    };
  }
}
