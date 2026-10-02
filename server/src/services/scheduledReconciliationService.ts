/**
 * Scheduled reconciliation orchestration (BE-124).
 *
 * Runs the portfolio reconciler on a schedule across a configured set of
 * wallets, persists a summary for each run, and raises operator alerts
 * through the notifications/monitoring path when:
 *
 *   1. Drift beyond a configurable threshold is observed, or
 *   2. A run (or a configurable number of consecutive runs) fails/skips.
 *
 * The reconciliation *execution* is injected via `ReconcileWalletFn` so the
 * orchestration logic stays pure and unit-testable; the job layer wires it to
 * `PortfolioReconcileService`.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type RunStatus = "success" | "partial" | "failed" | "skipped";

export type WalletRunStatus = "success" | "partial" | "failed";

export interface ReconcileWalletOutcome {
  status: WalletRunStatus;
  changeCount: number;
  mismatchCount: number;
  /** Max relative drift (0..1+) observed for this wallet. */
  driftPct: number;
  error?: string;
}

/**
 * Executes a single reconciliation for a wallet. Implementations may throw;
 * the scheduler converts a thrown error into a `failed` outcome.
 */
export interface ReconcileWalletFn {
  (walletAddress: string): Promise<ReconcileWalletOutcome>;
}

export interface ReconciliationRunDrift {
  walletAddress: string;
  status: WalletRunStatus;
  changeCount: number;
  mismatchCount: number;
  driftPct: number;
  error?: string;
}

export interface ScheduledReconciliationRun {
  id: string;
  startedAt: string;
  completedAt: string;
  status: RunStatus;
  walletsReconciled: number;
  changeCount: number;
  mismatchCount: number;
  maxDriftPct: number;
  alerted: boolean;
  alertReason?: "drift" | "unhealthy";
  /** Per-wallet drift detail for operators. */
  runs: ReconciliationRunDrift[];
  error?: string;
}

export interface ReconciliationAlert {
  level: "drift" | "unhealthy";
  message: string;
  run: ScheduledReconciliationRun;
}

/** Alert sink. The job wires this to notifications + operator email. */
export interface ReconciliationAlertSink {
  (alert: ReconciliationAlert): Promise<void>;
}

// ── In-memory run store (mirrors existing reconciliationStore pattern) ───────

const runStore: ScheduledReconciliationRun[] = [];

let consecutiveUnhealthyCount = 0;

export function resetScheduledReconciliationStore(): void {
  runStore.length = 0;
  consecutiveUnhealthyCount = 0;
}

export function getScheduledReconciliationRuns(): readonly ScheduledReconciliationRun[] {
  return runStore;
}

export function getConsecutiveUnhealthyCount(): number {
  return consecutiveUnhealthyCount;
}

export function queryScheduledReconciliationRuns(options: {
  limit?: number;
  status?: RunStatus;
  startDate?: string;
  endDate?: string;
} = {}): ScheduledReconciliationRun[] {
  let results = [...runStore];

  if (options.status) {
    results = results.filter((r) => r.status === options.status);
  }
  if (options.startDate) {
    const start = new Date(options.startDate).getTime();
    results = results.filter((r) => new Date(r.startedAt).getTime() >= start);
  }
  if (options.endDate) {
    const end = new Date(options.endDate).getTime();
    results = results.filter((r) => new Date(r.startedAt).getTime() <= end);
  }

  results.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  return results.slice(0, options.limit ?? 50);
}

export function getScheduledReconciliationRunById(
  id: string,
): ScheduledReconciliationRun | undefined {
  return runStore.find((r) => r.id === id);
}

// ── Drift assessment (pure) ────────────────────────────────────────────────

/**
 * Compute the maximum relative drift across a set of wallet outcomes and
 * whether it exceeds the configured threshold.
 */
export function assessDrift(
  driftThresholdPct: number,
  runs: ReconciliationRunDrift[],
): { maxDriftPct: number; overThreshold: boolean } {
  const maxDriftPct = runs.reduce((max, r) => Math.max(max, r.driftPct), 0);
  return { maxDriftPct, overThreshold: maxDriftPct > driftThresholdPct };
}

// ── Run orchestration ──────────────────────────────────────────────────────

function isUnhealthyRun(status: RunStatus): boolean {
  return status === "failed" || status === "skipped";
}

function makeId(): string {
  return `sched_recon_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Execute a scheduled reconciliation run across the configured wallets.
 *
 * @param config     resolved reconciliation config (schedule + thresholds)
 * @param reconcile  per-wallet reconciliation executor
 * @param sink       alert sink used when drift or consecutive failures occur
 */
export async function runScheduledReconciliation(
  config: {
    wallets: Array<{ walletAddress: string; expectedAmount?: number }>;
    driftThresholdPct: number;
    consecutiveFailAlert: number;
    alertsEnabled: boolean;
  },
  reconcile: ReconcileWalletFn,
  sink: ReconciliationAlertSink,
): Promise<ScheduledReconciliationRun> {
  const startedAt = new Date();
  const run: ReconciliationRunDrift[] = [];
  let runError: string | undefined;

  // No wallets configured => nothing to do; treat as a skipped run.
  if (config.wallets.length === 0) {
    consecutiveUnhealthyCount += 1;
    const summary: ScheduledReconciliationRun = {
      id: makeId(),
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      status: "skipped",
      walletsReconciled: 0,
      changeCount: 0,
      mismatchCount: 0,
      maxDriftPct: 0,
      alerted: false,
      runs: [],
      error: "No wallets configured for reconciliation.",
    };

    await applyAlert(config, summary, sink, consecutiveUnhealthyCount);

    runStore.push(summary);
    return summary;
  }

  for (const wallet of config.wallets) {
    let outcome: ReconcileWalletOutcome;
    try {
      outcome = await reconcile(wallet.walletAddress);
    } catch (error) {
      outcome = {
        status: "failed",
        changeCount: 0,
        mismatchCount: 0,
        driftPct: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    run.push({
      walletAddress: wallet.walletAddress,
      status: outcome.status,
      changeCount: outcome.changeCount,
      mismatchCount: outcome.mismatchCount,
      driftPct: outcome.driftPct,
      error: outcome.error,
    });
  }

  const { maxDriftPct, overThreshold } = assessDrift(
    config.driftThresholdPct,
    run,
  );

  const failedCount = run.filter((r) => r.status === "failed").length;
  const anyDrifted = overThreshold;

  let status: RunStatus;
  if (run.length > 0 && failedCount === run.length) {
    status = "failed";
    runError = "Every configured wallet failed reconciliation.";
  } else if (failedCount > 0 || anyDrifted) {
    status = "partial";
  } else {
    status = "success";
  }

  if (isUnhealthyRun(status)) {
    consecutiveUnhealthyCount += 1;
    runError = runError ?? "One or more wallets failed reconciliation.";
  } else {
    consecutiveUnhealthyCount = 0;
  }

  const summary: ScheduledReconciliationRun = {
    id: makeId(),
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    status,
    walletsReconciled: run.length,
    changeCount: run.reduce((s, r) => s + r.changeCount, 0),
    mismatchCount: run.reduce((s, r) => s + r.mismatchCount, 0),
    maxDriftPct,
    alerted: false,
    runs: run,
    error: runError,
  };

  runStore.push(summary);

  await applyAlert(config, summary, sink, consecutiveUnhealthyCount);

  return summary;
}

/**
 * Decide whether to raise an alert for this run and, if so, invoke the sink
 * and record the outcome on the run summary (mutated in place so it persists
 * in the store).
 */
async function applyAlert(
  config: {
    driftThresholdPct: number;
    consecutiveFailAlert: number;
    alertsEnabled: boolean;
  },
  run: ScheduledReconciliationRun,
  sink: ReconciliationAlertSink,
  consecutiveCount: number,
): Promise<void> {
  if (!config.alertsEnabled) return;

  // Consecutive failed/skipped runs are themselves unhealthy.
  if (
    consecutiveCount >= config.consecutiveFailAlert &&
    isUnhealthyRun(run.status)
  ) {
    run.alerted = true;
    run.alertReason = "unhealthy";
    const alert: ReconciliationAlert = {
      level: "unhealthy",
      message:
        `Scheduled reconciliation has had ${consecutiveCount} consecutive ` +
        `failed or skipped runs. Last run status: ${run.status}.`,
      run,
    };
    try {
      await sink(alert);
    } catch (error) {
      console.error(
        "[scheduledReconciliation] failed to raise unhealthy alert",
        error,
      );
    }
    return;
  }

  // Drift beyond threshold on a successful (or partially successful) run.
  if (run.maxDriftPct > config.driftThresholdPct) {
    run.alerted = true;
    run.alertReason = "drift";
    const alert: ReconciliationAlert = {
      level: "drift",
      message:
        `Scheduled reconciliation detected drift of ` +
        `${(run.maxDriftPct * 100).toFixed(2)}% across ${run.runs.length} wallet(s), ` +
        `exceeding the ${(config.driftThresholdPct * 100).toFixed(2)}% threshold.`,
      run,
    };
    try {
      await sink(alert);
    } catch (error) {
      console.error(
        "[scheduledReconciliation] failed to raise drift alert",
        error,
      );
    }
  }
}

// ── Default alert sink (notifications/monitoring path) ───────────────────────

interface NotificationModel {
  create(opts: {
    data: {
      walletAddress: string;
      type: string;
      title: string;
      message: string;
    };
  }): Promise<unknown>;
}

export interface ReconciliationAlertPrisma {
  notification: NotificationModel;
}

/**
 * Default alert sink used by the job layer. Persists a notification through
 * the notifications/monitoring path (a `RECONCILIATION` notification) and
 * additionally emails the configured operator mailbox. Email failures are
 * non-fatal; notification persistence errors propagate so the caller can log.
 *
 * @param prisma       Prisma client scoped to the `notification` model.
 * @param operatorEmail    recipient mailbox for the operator alert email.
 * @param sendEmail        email transport (defaults to console stub).
 */
export function createReconciliationAlertSink(
  prisma: ReconciliationAlertPrisma,
  operatorEmail: string,
  sendEmail?: (
    options: { to: string; subject: string; html: string },
  ) => Promise<void>,
): ReconciliationAlertSink {
  return async (alert) => {
    const subject =
      alert.level === "unhealthy"
        ? "StellarYield: reconciliation scheduler unhealthy"
        : "StellarYield: reconciliation drift alert";

    await prisma.notification.create({
      data: {
        walletAddress: "system",
        type: "RECONCILIATION",
        title: subject,
        message: alert.message,
      },
    });

    if (sendEmail) {
      try {
        await sendEmail({ to: operatorEmail, subject, html: alert.message });
      } catch (error) {
        console.error(
          "[scheduledReconciliation] failed to email operator",
          error,
        );
      }
    }
  };
}
