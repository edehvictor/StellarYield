/**
 * Rewards accrual reconciliation.
 *
 * Compares accrued rewards — the `components.rewards` figure the PnL engine
 * derives from HARVEST transactions (see `pnl_engine/pnlCalculator.ts`) — against
 * the actual recorded transaction history for the same wallet and period, so a
 * mismatch between "what we think was accrued" and "what the ledger/chain
 * actually recorded" is flagged instead of silently trusted.
 *
 * Discrepancies are reported as a typed result, never thrown: an over- or
 * under-accrual is an operational signal for the caller to act on (freeze
 * payouts, re-run the indexer, page an operator), not an exceptional control
 *-flow event. This mirrors the ReconcileRow / ReconciliationResult convention
 * already used by `portfolioReconcileService.ts`.
 */

/** A recorded transaction from transaction history, in the same shape UserTransaction rows take. */
export interface RewardsHistoryTransaction {
  txHash: string;
  walletAddress: string;
  /** DEPOSIT | WITHDRAW | HARVEST (only HARVEST rows count toward rewards). */
  action: string;
  amount: number;
  timestamp: Date;
  /** Optional: reward amount when it differs from `amount` (matches PnLTransaction.reward). */
  reward?: number;
}

/** Inclusive period bounds a reconciliation run applies to. */
export interface ReconciliationPeriod {
  start: Date;
  end: Date;
}

export interface RewardsAccrualReconcileInput {
  walletAddress: string;
  /** The rewards-accrual source of truth for this period (e.g. calculatePnL(...).components.rewards). */
  accruedRewards: number;
  /** Recorded transaction history to compare against. Rows outside `period` are ignored. */
  transactions: RewardsHistoryTransaction[];
  period: ReconciliationPeriod;
  /**
   * Relative tolerance (fraction of the larger of the two totals) below which a
   * difference is treated as rounding noise rather than a discrepancy. Defaults
   * to 0.0001 (0.01%), matching the epsilon convention used elsewhere in the
   * reconciliation code (see AMOUNT_EPSILON in portfolioReconcileService.ts).
   */
  tolerance?: number;
}

export type RewardsAccrualDiscrepancyType =
  | "none"
  | "over_accrual"
  | "under_accrual";

export interface RewardsAccrualReconciliationResult {
  walletAddress: string;
  period: ReconciliationPeriod;
  /** The accrued-rewards figure being checked. */
  accruedRewards: number;
  /** Sum of HARVEST transaction amounts recorded in history for this period. */
  recordedRewards: number;
  /** accruedRewards - recordedRewards. Positive means over-accrual, negative means under-accrual. */
  delta: number;
  /** delta as a fraction of the larger of the two totals; 0 when both are 0. */
  deltaPct: number;
  discrepancyType: RewardsAccrualDiscrepancyType;
  /** True when |deltaPct| exceeds the configured tolerance. */
  hasDiscrepancy: boolean;
  /** Number of HARVEST transactions found in the period. */
  matchedTransactionCount: number;
}

const DEFAULT_TOLERANCE = 0.0001;

/**
 * Reconciles accrued rewards against recorded transaction history for one
 * wallet over one period.
 *
 * Never throws on a mismatch — a discrepancy is reported via
 * `discrepancyType`/`hasDiscrepancy` on the returned result. Callers that want
 * hard failure (e.g. a CI or cron gate) should inspect `hasDiscrepancy`
 * themselves.
 */
export function reconcileRewardsAccrual(
  input: RewardsAccrualReconcileInput,
): RewardsAccrualReconciliationResult {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;

  const inPeriod = input.transactions.filter(
    (tx) =>
      tx.walletAddress === input.walletAddress &&
      tx.timestamp.getTime() >= input.period.start.getTime() &&
      tx.timestamp.getTime() <= input.period.end.getTime(),
  );

  const harvestTxs = inPeriod.filter((tx) => tx.action === "HARVEST");

  const recordedRewards = harvestTxs.reduce(
    (sum, tx) => sum + (tx.reward ?? tx.amount),
    0,
  );

  const delta = input.accruedRewards - recordedRewards;
  const largerMagnitude = Math.max(
    Math.abs(input.accruedRewards),
    Math.abs(recordedRewards),
  );
  const deltaPct = largerMagnitude === 0 ? 0 : Math.abs(delta) / largerMagnitude;

  const hasDiscrepancy = deltaPct > tolerance;

  let discrepancyType: RewardsAccrualDiscrepancyType = "none";
  if (hasDiscrepancy) {
    discrepancyType = delta > 0 ? "over_accrual" : "under_accrual";
  }

  return {
    walletAddress: input.walletAddress,
    period: input.period,
    accruedRewards: input.accruedRewards,
    recordedRewards,
    delta,
    deltaPct,
    discrepancyType,
    hasDiscrepancy,
    matchedTransactionCount: harvestTxs.length,
  };
}
