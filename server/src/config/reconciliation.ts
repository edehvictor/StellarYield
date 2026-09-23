/**
 * Scheduled reconciliation configuration (BE-124).
 *
 * Controls how often the scheduled reconciliation run fires, the drift
 * threshold that trippers an operator alert, and how many consecutive
 * failed/skipped runs must pile up before the scheduler itself raises an
 * alert. Every value is deploy-time configurable via environment variables
 * and degrades to a safe default when missing or malformed.
 *
 * | Variable                              | Default                  |
 * | ------------------------------------- | ------------------------ |
 * | `RECONCILIATION_SCHEDULE`             | `0 */6 * * *` (every 6h)|
 * | `RECONCILIATION_DRIFT_THRESHOLD_PCT`  | `0.05` (5%)              |
 * | `RECONCILIATION_CONSECUTIVE_ALERT`    | `3`                      |
 * | `RECONCILIATION_WALLETS`              | (none)                   |
 * | `RECONCILIATION_ALERTS_ENABLED`       | `true`                   |
 * | `RECONCILIATION_OPERATOR_EMAIL`       | `operator@stellaryield.com` |
 */

/**
 * A wallet selected for scheduled reconciliation. `expectedAmount` is an
 * optional ledger expectation; when present, the runner compares the backing
 * store value to it and reports the relative divergence (drift).
 */
export interface ReconciliationWalletSpec {
  walletAddress: string;
  expectedAmount?: number;
}

export interface ReconciliationConfig {
  /** cron expression for the scheduled run. */
  schedule: string;
  /**
   * Relative drift (0..1) beyond which a reconciliation divergence is
   * considered material and raises an operator alert.
   */
  driftThresholdPct: number;
  /**
   * Number of consecutive failed or skipped runs tolerated before the
   * scheduler raises its own "unhealthy" alert.
   */
  consecutiveFailAlert: number;
  /**
   * Wallet specifications to reconcile on each scheduled run. Each entry may
   * carry an optional `expectedAmount` used as the ledger expectation.
   */
  wallets: ReconciliationWalletSpec[];
  /** Master switch for alerting (set to "false" to disable). */
  alertsEnabled: boolean;
  /** Operator mailbox that receives drift / scheduler alerts. */
  operatorEmail: string;
}

function readNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function readFraction(
  raw: string | undefined,
  fallback: number,
): number {
  // Clamp into a sane (0, 1] share.
  const v = readNumber(raw, fallback, 0);
  return v > 1 ? 1 : v;
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  return raw.trim().toLowerCase() === "true";
}

/**
 * Parse the `RECONCILIATION_WALLETS` variable.
 *
 * Entries are comma-separated wallet addresses, optionally with a ledger
 * expectation in the form `address:expectedAmount`, e.g.
 * `GABC...:1000.5,GDEF...` meaning reconcile `GABC...` against an expected
 * balance of 1000.5 and `GDEF...` against whatever its backing store holds.
 */
export function parseWalletSpecs(
  raw: string | undefined,
): ReconciliationWalletSpec[] {
  return (raw ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .map((entry) => {
      const [address, amountRaw] = entry.split(":");
      const walletAddress = address?.trim() ?? "";
      if (!walletAddress) return null;
      const expectedAmount = amountRaw
        ? Number(amountRaw.trim())
        : undefined;
      return {
        walletAddress,
        expectedAmount:
          expectedAmount !== undefined && Number.isFinite(expectedAmount)
            ? expectedAmount
            : undefined,
      };
    })
    .filter((w): w is ReconciliationWalletSpec => w !== null);
}

/**
 * Resolve the deployed reconciliation configuration, applying defaults for
 * anything missing or malformed.
 */
export function resolveReconciliationConfig(
  env: NodeJS.ProcessEnv = process.env,
): ReconciliationConfig {
  return {
    schedule: env.RECONCILIATION_SCHEDULE?.trim() || "0 */6 * * *",
    driftThresholdPct: readFraction(
      env.RECONCILIATION_DRIFT_THRESHOLD_PCT,
      0.05,
    ),
    consecutiveFailAlert: readNumber(
      env.RECONCILIATION_CONSECUTIVE_ALERT,
      3,
      1,
    ),
    wallets: parseWalletSpecs(env.RECONCILIATION_WALLETS),
    alertsEnabled: readBool(env.RECONCILIATION_ALERTS_ENABLED, true),
    operatorEmail:
      env.RECONCILIATION_OPERATOR_EMAIL?.trim() ||
      "operator@stellaryield.com",
  };
}

export { resolveReconciliationConfig as getReconciliationConfig };
