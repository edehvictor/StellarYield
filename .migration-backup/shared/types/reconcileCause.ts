/**
 * Reconciliation failure cause codes.
 *
 * When a portfolio reconciliation does not come out clean, the operator's first
 * question is *why* — and the three answers have completely different
 * responses. A holding the chain reports but the cache has never seen is a
 * projection gap. The same holding under a renamed asset code is symbol drift,
 * and "re-index" makes it worse. A checkpoint that stopped advancing is a stale
 * source, and the numbers are not wrong so much as old.
 *
 * A bare severity ("critical") cannot distinguish those, so this module names
 * the cause, and both the server and the UI import the same names.
 */

export type ReconcileCauseCode =
  /** Chain reports a holding the cached projection has never seen. */
  | "MISSING_HOLDING"
  /** Cache holds a position the chain no longer reports. */
  | "ORPHANED_HOLDING"
  /** Same economic position under a different asset code on each side. */
  | "SYMBOL_DRIFT"
  /** The projection behind the cached side has stopped advancing. */
  | "STALE_SOURCE"
  /** Both sides agree the position exists, but not on the amount. */
  | "AMOUNT_DRIFT"
  /** The same asset appears more than once for a single vault. */
  | "DUPLICATE_POSITION"
  /** A recorded transaction has no matching on-chain event. */
  | "ORPHANED_TRANSACTION"
  /** Reconciliation could not run at all — the source threw. */
  | "SOURCE_UNAVAILABLE";

/** How much operator attention a cause warrants. */
export type ReconcileCauseSeverity = "info" | "warning" | "critical";

/**
 * What the UI needs in order to render a cause without re-deriving any of it.
 * `category` is the coarse split the issue asks the UI to make: missing data
 * versus symbol drift versus stale source.
 */
export type ReconcileCauseCategory = "missing-data" | "symbol-drift" | "stale-source" | "amount" | "integrity";

export interface ReconcileCauseDescriptor {
  code: ReconcileCauseCode;
  category: ReconcileCauseCategory;
  severity: ReconcileCauseSeverity;
  /** Short label for a table cell or badge. */
  title: string;
  /** One sentence an operator can read without opening the code. */
  summary: string;
  /** The next action, phrased as something to do rather than something to know. */
  remediation: string;
}

export const RECONCILE_CAUSES: Record<ReconcileCauseCode, ReconcileCauseDescriptor> = {
  MISSING_HOLDING: {
    code: "MISSING_HOLDING",
    category: "missing-data",
    severity: "critical",
    title: "Missing holding",
    summary:
      "The chain reports this holding but the cached projection has no record of it.",
    remediation:
      "Replay the indexer from the last known-good ledger for this wallet; the deposit event was most likely dropped rather than the balance being wrong.",
  },
  ORPHANED_HOLDING: {
    code: "ORPHANED_HOLDING",
    category: "missing-data",
    severity: "warning",
    title: "Orphaned holding",
    summary:
      "The cache holds this position but the chain no longer reports it.",
    remediation:
      "Confirm the withdrawal or migration on-chain, then let the reconciler clear the cached position. Do not delete it by hand until the chain side is confirmed.",
  },
  SYMBOL_DRIFT: {
    code: "SYMBOL_DRIFT",
    category: "symbol-drift",
    severity: "warning",
    title: "Symbol drift",
    summary:
      "The same position is carried under a different asset code on each side, so it reads as one holding missing and another appearing.",
    remediation:
      "Add the pair to the asset alias map rather than re-indexing — the balance is intact and a replay will simply reproduce the rename.",
  },
  STALE_SOURCE: {
    code: "STALE_SOURCE",
    category: "stale-source",
    severity: "warning",
    title: "Stale source",
    summary:
      "The projection behind the cached side has stopped advancing, so any difference here may simply be lag rather than a real discrepancy.",
    remediation:
      "Check indexer health and the last processed ledger before acting on any other cause in this run; resolve the lag first, then re-reconcile.",
  },
  AMOUNT_DRIFT: {
    code: "AMOUNT_DRIFT",
    category: "amount",
    severity: "warning",
    title: "Amount drift",
    summary: "Both sides carry this position, but the amounts disagree.",
    remediation:
      "Compare the position's event history against the chain balance; a partial withdrawal or a missed rebalance leg is the usual cause.",
  },
  DUPLICATE_POSITION: {
    code: "DUPLICATE_POSITION",
    category: "integrity",
    severity: "critical",
    title: "Duplicate position",
    summary: "The same asset appears more than once for a single vault.",
    remediation:
      "Deduplicate at the projection level before trusting any total for this vault — the aggregate is double-counting.",
  },
  ORPHANED_TRANSACTION: {
    code: "ORPHANED_TRANSACTION",
    category: "integrity",
    severity: "warning",
    title: "Orphaned transaction",
    summary: "A recorded transaction has no matching on-chain event.",
    remediation:
      "Confirm the transaction hash on-chain; if it never settled, void the record rather than reconciling around it.",
  },
  SOURCE_UNAVAILABLE: {
    code: "SOURCE_UNAVAILABLE",
    category: "stale-source",
    severity: "critical",
    title: "Source unavailable",
    summary: "Reconciliation could not run — a source threw before any comparison was made.",
    remediation:
      "Treat this run as producing no information: the absence of other causes here is not evidence that the portfolio is clean. Fix the source and re-run.",
  },
};

/** Every cause code, in the order an operator should triage them. */
export const RECONCILE_CAUSE_ORDER: ReconcileCauseCode[] = [
  "SOURCE_UNAVAILABLE",
  "STALE_SOURCE",
  "MISSING_HOLDING",
  "SYMBOL_DRIFT",
  "DUPLICATE_POSITION",
  "AMOUNT_DRIFT",
  "ORPHANED_HOLDING",
  "ORPHANED_TRANSACTION",
];

export function describeReconcileCause(code: ReconcileCauseCode): ReconcileCauseDescriptor {
  return RECONCILE_CAUSES[code];
}

/**
 * True when the cause means "we could not see the data", as opposed to "we saw
 * it and it disagreed". The UI uses this to keep missing data visually distinct
 * from symbol drift, which is the distinction the operator acts on.
 */
export function isMissingDataCause(code: ReconcileCauseCode): boolean {
  return RECONCILE_CAUSES[code].category === "missing-data";
}

export function isSymbolDriftCause(code: ReconcileCauseCode): boolean {
  return RECONCILE_CAUSES[code].category === "symbol-drift";
}

/** Highest severity among the given causes, or null when there are none. */
export function worstSeverity(
  codes: ReconcileCauseCode[],
): ReconcileCauseSeverity | null {
  const rank: Record<ReconcileCauseSeverity, number> = { info: 0, warning: 1, critical: 2 };
  let worst: ReconcileCauseSeverity | null = null;
  for (const code of codes) {
    const severity = RECONCILE_CAUSES[code].severity;
    if (worst === null || rank[severity] > rank[worst]) worst = severity;
  }
  return worst;
}
