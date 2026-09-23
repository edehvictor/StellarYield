/**
 * Scheduled reconciliation job (BE-124).
 *
 * Wires a node-cron scheduler to the reconciliation orchestration and the
 * notifications / monitoring alert path. Each run reconciles the configured
 * wallets against their backing store, persists a per-run summary, and raises
 * operator alerts when drift exceeds the configured threshold or when a run
 * (or a streak of runs) fails/skips. The default runner compares each wallet's
 * stored vault balance against an optional ledger expectation from
 * `RECONCILIATION_WALLETS` (format `address:expectedAmount`).
 */
import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import {
  runScheduledReconciliation,
  createReconciliationAlertSink,
  type ReconcileWalletOutcome,
} from "../services/scheduledReconciliationService";
import {
  getReconciliationConfig,
  type ReconciliationConfig,
  type ReconciliationWalletSpec,
} from "../config/reconciliation";
import { sendEmail } from "../services/emailService";

const prisma = new PrismaClient();
let jobHandle: ReturnType<typeof cron.schedule> | null = null;

function buildRunner(
  wallets: ReconciliationWalletSpec[],
): (walletAddress: string) => Promise<ReconcileWalletOutcome> {
  const expectedByWallet = new Map<string, number>();
  for (const w of wallets) {
    if (w.expectedAmount !== undefined) {
      expectedByWallet.set(w.walletAddress, w.expectedAmount);
    }
  }

  return async (walletAddress) => {
    const expected = expectedByWallet.get(walletAddress);

    // No ledger expectation configured; nothing to compare against, so the
    // wallet is clean by default and the reconciliation is a no-op success.
    if (expected === undefined) {
      return {
        status: "success",
        changeCount: 0,
        mismatchCount: 0,
        driftPct: 0,
      };
    }

    let cachedTvl: number;
    try {
      const balance = await prisma.vaultBalance.findUnique({
        where: { walletAddress },
      });
      // A configured expectation with no backing record is a data gap.
      if (!balance) {
        return {
          status: "failed",
          changeCount: 0,
          mismatchCount: 1,
          driftPct: 1,
          error: "No cached vault balance found for wallet.",
        };
      }
      cachedTvl = balance.tvl ?? 0;
    } catch (error) {
      throw error;
    }

    if (expected === 0) {
      return { status: "success", changeCount: 0, mismatchCount: 0, driftPct: 0 };
    }

    const driftPct = Math.abs(cachedTvl - expected) / Math.abs(expected);
    const drifted = driftPct > 0.0001;

    return {
      status: drifted ? "partial" : "success",
      changeCount: 0,
      mismatchCount: drifted ? 1 : 0,
      driftPct,
    };
  };
}

/**
 * Run a single scheduled reconciliation pass and return its summary. Exposed
 * so operators or tests can trigger a pass on demand.
 */
export async function runScheduledReconciliationOnce(
  config: ReconciliationConfig = getReconciliationConfig(),
) {
  const sink = createReconciliationAlertSink(
    // The Prisma client satisfies the minimal notification model surface.
    prisma as unknown as Parameters<typeof createReconciliationAlertSink>[0],
    config.operatorEmail,
    sendEmail,
  );

  return runScheduledReconciliation(
    {
      wallets: config.wallets,
      driftThresholdPct: config.driftThresholdPct,
      consecutiveFailAlert: config.consecutiveFailAlert,
      alertsEnabled: config.alertsEnabled,
    },
    buildRunner(config.wallets),
    sink,
  );
}

export function startScheduledReconciliationJob(
  schedule = getReconciliationConfig().schedule,
  config: ReconciliationConfig = getReconciliationConfig(),
) {
  if (jobHandle) return;

  console.log(
    `Starting Scheduled Reconciliation Job with schedule: ${schedule}`,
  );

  jobHandle = cron.schedule(schedule, async () => {
    try {
      const run = await runScheduledReconciliationOnce(config);
      console.log(
        `[ScheduledReconciliation] run ${run.id} completed with status ${run.status}` +
          (run.alerted ? ` (raised ${run.alertReason} alert)` : ""),
      );
    } catch (error) {
      console.error("Scheduled Reconciliation Job failed:", error);
    }
  });
}

export function stopScheduledReconciliationJob() {
  if (jobHandle) {
    jobHandle.stop();
    jobHandle = null;
    console.log("Scheduled Reconciliation Job stopped");
  }
}
