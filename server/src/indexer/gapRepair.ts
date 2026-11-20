/**
 * Indexer Gap Repair (#1154)
 *
 * Operators can trigger a gap repair run over an explicit ledger range when
 * the indexer is known to have missed contract events. A run scans every
 * dead-letter event whose ledger lies within `[startLedger, endLedger]`,
 * replays the unresolved ones, and persists a summary row so the scanned
 * range and its outcome are auditable:
 *
 *   - `restoredCount`    — unresolved at start, replayed successfully now
 *   - `skippedCount`     — already resolved before this run (no action needed)
 *   - `stillMissingCount`— still unresolved after this run
 *
 * so `restoredCount + skippedCount + stillMissingCount === scannedCount`.
 *
 * Failed runs are persisted with a typed failure reason
 * (`GapRepairFailureCode`) so operators can tell an invalid request apart
 * from a storage or replay failure. Summaries are exposed through
 * `GET /api/indexer/recovery-queue/gap-repair`.
 */

import { replayDeadLetter, type IndexerPrismaClient } from "./indexer";

/** Typed failure reasons for gap repair runs (#1154). */
export type GapRepairFailureCode =
  | "INVALID_RANGE"
  | "PRISMA_UNAVAILABLE"
  | "REPLAY_ERROR";

/**
 * Typed failure raised by gap repair. Routes map `statusCode` to the HTTP
 * response and surface `code`/`details` through the error envelope.
 */
export class GapRepairError extends Error {
  readonly code: GapRepairFailureCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(
    code: GapRepairFailureCode,
    message: string,
    statusCode: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "GapRepairError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Persisted summary of one gap repair run. */
export interface GapRepairRunSummary {
  runId: string | null;
  startLedger: number;
  endLedger: number;
  /** Total dead-letter events found in the scanned range. */
  scannedCount: number;
  restoredCount: number;
  skippedCount: number;
  stillMissingCount: number;
  status: "completed" | "failed";
  /** Typed failure reason for failed runs; null when completed. */
  failureReason: { code: GapRepairFailureCode; message: string } | null;
  startedAt: string;
  finishedAt: string;
}

/** Upper bound on dead letters replayed in a single run. */
export const GAP_REPAIR_MAX_SCAN = 1000;

interface GapRepairInput {
  startLedger: unknown;
  endLedger: unknown;
  /** Optional clock override for deterministic tests. */
  now?: number;
}

function validateRange(
  startLedger: unknown,
  endLedger: unknown,
): { startLedger: number; endLedger: number } {
  if (
    !Number.isInteger(startLedger) ||
    !Number.isInteger(endLedger) ||
    (startLedger as number) < 0 ||
    (endLedger as number) < (startLedger as number)
  ) {
    throw new GapRepairError(
      "INVALID_RANGE",
      "startLedger and endLedger must be non-negative integers with startLedger <= endLedger.",
      400,
      { startLedger, endLedger },
    );
  }
  return {
    startLedger: startLedger as number,
    endLedger: endLedger as number,
  };
}

function toSummary(row: {
  id: string;
  startLedger: number;
  endLedger: number;
  restoredCount: number;
  skippedCount: number;
  stillMissingCount: number;
  status: string;
  failureReasonCode: string | null;
  failureReasonMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}): GapRepairRunSummary {
  return {
    runId: row.id,
    startLedger: row.startLedger,
    endLedger: row.endLedger,
    scannedCount: row.restoredCount + row.skippedCount + row.stillMissingCount,
    restoredCount: row.restoredCount,
    skippedCount: row.skippedCount,
    stillMissingCount: row.stillMissingCount,
    status: row.status === "failed" ? "failed" : "completed",
    failureReason: row.failureReasonCode
      ? {
          code: row.failureReasonCode as GapRepairFailureCode,
          message: row.failureReasonMessage ?? "",
        }
      : null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : "",
  };
}

/**
 * Run a gap repair over `[startLedger, endLedger]` and persist its summary.
 *
 * @throws {GapRepairError} INVALID_RANGE (400) for malformed ranges,
 *   PRISMA_UNAVAILABLE (503) when storage is missing, and REPLAY_ERROR (500)
 *   when the run fails mid-flight — failed runs are persisted with a typed
 *   failure reason when storage allows.
 */
export async function runGapRepair(
  prisma: IndexerPrismaClient | null,
  input: GapRepairInput,
): Promise<GapRepairRunSummary> {
  const { startLedger, endLedger } = validateRange(
    input.startLedger,
    input.endLedger,
  );
  const startedAt = new Date(input.now ?? Date.now());

  if (!prisma) {
    throw new GapRepairError(
      "PRISMA_UNAVAILABLE",
      "Indexer storage is unavailable; gap repair cannot run.",
      503,
    );
  }

  let scannedCount = 0;
  let restoredCount = 0;
  let skippedCount = 0;
  let stillMissingCount = 0;

  try {
    const ledgerRange = { gte: startLedger, lte: endLedger };

    skippedCount = await prisma.deadLetterEvent.count({
      where: { resolved: true, ledger: ledgerRange },
    });
    const unresolvedBefore = await prisma.deadLetterEvent.count({
      where: { resolved: false, ledger: ledgerRange },
    });
    scannedCount = skippedCount + unresolvedBefore;

    const unresolved = await prisma.deadLetterEvent.findMany({
      where: { resolved: false, ledger: ledgerRange },
      orderBy: { nextRetryAt: "asc" },
      take: GAP_REPAIR_MAX_SCAN,
    });

    let restored = 0;
    for (const deadLetter of unresolved) {
      const ok = await replayDeadLetter(prisma, deadLetter);
      if (ok) restored += 1;
    }
    restoredCount = restored;

    stillMissingCount = await prisma.deadLetterEvent.count({
      where: { resolved: false, ledger: ledgerRange },
    });

    const finishedAt = new Date();
    const run = await prisma.indexerRepairRun.create({
      data: {
        startLedger,
        endLedger,
        restoredCount,
        skippedCount,
        stillMissingCount,
        status: "completed",
        startedAt,
        finishedAt,
      },
    });

    return {
      runId: run.id,
      startLedger,
      endLedger,
      scannedCount,
      restoredCount,
      skippedCount,
      stillMissingCount,
      status: "completed",
      failureReason: null,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };
  } catch (error) {
    const failureMessage =
      error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();

    const summary: GapRepairRunSummary = {
      runId: null,
      startLedger,
      endLedger,
      scannedCount,
      restoredCount,
      skippedCount,
      stillMissingCount,
      status: "failed",
      failureReason: { code: "REPLAY_ERROR", message: failureMessage },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };

    // Best effort: persist the failed run so operators can audit it.
    try {
      const run = await prisma.indexerRepairRun.create({
        data: {
          startLedger,
          endLedger,
          restoredCount,
          skippedCount,
          stillMissingCount,
          status: "failed",
          failureReasonCode: "REPLAY_ERROR",
          failureReasonMessage: failureMessage.slice(0, 500),
          startedAt,
          finishedAt,
        },
      });
      summary.runId = run.id;
    } catch {
      // Storage unavailable — the typed error below still surfaces the reason.
    }

    throw new GapRepairError(
      "REPLAY_ERROR",
      `Gap repair run failed: ${failureMessage}`,
      500,
      { run: summary },
    );
  }
}

/**
 * List persisted gap repair summaries, newest first.
 *
 * @throws {GapRepairError} PRISMA_UNAVAILABLE (503) when storage is missing.
 */
export async function listGapRepairRuns(
  prisma: IndexerPrismaClient | null,
  limit: number = 20,
): Promise<GapRepairRunSummary[]> {
  if (!prisma) {
    throw new GapRepairError(
      "PRISMA_UNAVAILABLE",
      "Indexer storage is unavailable; repair summaries cannot be listed.",
      503,
    );
  }

  const take = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const runs = await prisma.indexerRepairRun.findMany({
    orderBy: { startedAt: "desc" },
    take,
  });

  return runs.map(toSummary);
}
