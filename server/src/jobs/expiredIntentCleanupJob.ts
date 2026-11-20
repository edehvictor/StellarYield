/**
 * #1417 — Scheduled sweep for expired transaction intents.
 *
 * Wires `cleanupExpiredTransactionIntents` to a node-cron schedule,
 * mirroring the start/stop/run-once shape used by
 * `scheduledReconciliationJob.ts` and `driftDetectionJob.ts`.
 */
import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { cleanupExpiredTransactionIntents } from "../services/expiredIntentCleanupService";

const prisma = new PrismaClient();
let jobHandle: ReturnType<typeof cron.schedule> | null = null;

/** Every 15 minutes by default — expiry windows here are measured in minutes, not hours. */
export function getExpiredIntentCleanupSchedule(): string {
  return process.env.EXPIRED_INTENT_CLEANUP_SCHEDULE ?? "*/15 * * * *";
}

export async function runExpiredIntentCleanupOnce() {
  return cleanupExpiredTransactionIntents(prisma);
}

export function startExpiredIntentCleanupJob(schedule = getExpiredIntentCleanupSchedule()) {
  if (jobHandle) return;

  console.log(`Starting Expired Intent Cleanup Job with schedule: ${schedule}`);

  jobHandle = cron.schedule(schedule, async () => {
    try {
      const summary = await runExpiredIntentCleanupOnce();
      if (summary.errors.length > 0) {
        console.error(
          `[ExpiredIntentCleanup] completed with errors: ${summary.errors.join(", ")}`,
        );
      } else if (summary.expiredWithdrawals > 0 || summary.expiredRebalanceIntents > 0) {
        console.log(
          `[ExpiredIntentCleanup] expired ${summary.expiredWithdrawals} withdrawal(s), ` +
            `${summary.expiredRebalanceIntents} rebalance intent(s)`,
        );
      }
    } catch (error) {
      console.error("Expired Intent Cleanup Job failed:", error);
    }
  });
}

export function stopExpiredIntentCleanupJob() {
  if (jobHandle) {
    jobHandle.stop();
    jobHandle = null;
    console.log("Expired Intent Cleanup Job stopped");
  }
}
