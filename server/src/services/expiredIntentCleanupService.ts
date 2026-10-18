/**
 * #1417 — Backend cleanup job for expired transaction intents.
 *
 * Two queue models hold transaction "intents" that a user or the system
 * has started but not yet executed on-chain, each with its own expiry:
 *
 *  - `WithdrawalQueueEntry.expiresAt` — a queued/executable withdrawal
 *    request past its slippage-protection window (Issue #900).
 *  - `RebalanceQueueEntry.intentValidUntil` — a pending rebalance intent
 *    past its replay-prevention validity window (Issue #281).
 *
 * Neither had a sweep: a `WithdrawalQueueEntry` left QUEUED/EXECUTABLE
 * past `expiresAt`, or a `RebalanceQueueEntry` left PENDING past
 * `intentValidUntil`, stayed in that state forever — visible to any
 * consumer as "still pending" when it should read as expired. This
 * service marks them terminal (`EXPIRED` / `CANCELLED`, both already
 * valid states in the existing status enums) instead of executing or
 * deleting them, preserving the audit trail.
 */
import { PrismaClient, Prisma } from "@prisma/client";

export interface ExpiredIntentCleanupSummary {
  ranAt: string;
  expiredWithdrawals: number;
  expiredRebalanceIntents: number;
  /** Stable, typed failure reasons — never a raw driver/provider error. */
  errors: string[];
}

const WITHDRAWAL_EXPIRABLE_STATUSES = ["QUEUED", "EXECUTABLE"] as const;
const WITHDRAWAL_EXPIRY_REASON = "Expired before execution";
const REBALANCE_EXPIRY_ERROR = "Intent expired before execution (past intentValidUntil)";

/**
 * Sweeps expired withdrawal and rebalance intents. Each queue is swept
 * independently — a failure sweeping one never blocks the other — and
 * every failure is reduced to a stable message rather than surfacing the
 * underlying Prisma error.
 */
export async function cleanupExpiredTransactionIntents(
  prisma: Pick<PrismaClient, "withdrawalQueueEntry" | "rebalanceQueueEntry">,
  now: Date = new Date(),
): Promise<ExpiredIntentCleanupSummary> {
  const errors: string[] = [];

  const expiredWithdrawals = await sweep(errors, "withdrawal queue", () =>
    prisma.withdrawalQueueEntry.updateMany({
      where: {
        status: { in: [...WITHDRAWAL_EXPIRABLE_STATUSES] },
        expiresAt: { lt: now },
      },
      data: {
        status: "EXPIRED",
        cancelledAt: now,
        cancellationReason: WITHDRAWAL_EXPIRY_REASON,
      },
    }),
  );

  const expiredRebalanceIntents = await sweep(errors, "rebalance queue", () =>
    prisma.rebalanceQueueEntry.updateMany({
      where: {
        status: "PENDING",
        intentValidUntil: { lt: now },
      },
      data: {
        status: "CANCELLED",
        lastError: REBALANCE_EXPIRY_ERROR,
      },
    }),
  );

  return {
    ranAt: now.toISOString(),
    expiredWithdrawals,
    expiredRebalanceIntents,
    errors,
  };
}

async function sweep(
  errors: string[],
  label: string,
  run: () => Prisma.PrismaPromise<{ count: number }>,
): Promise<number> {
  try {
    const result = await run();
    return result.count;
  } catch {
    // Deliberately swallow the driver error — callers (job scheduler,
    // any future admin endpoint) get a stable typed message instead of a
    // raw Prisma/Postgres error, per the issue's failure-state contract.
    errors.push(`Failed to sweep expired ${label} intents`);
    return 0;
  }
}
