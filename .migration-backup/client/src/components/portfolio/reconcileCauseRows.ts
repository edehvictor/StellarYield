/**
 * Maps a `POST /api/portfolio/reconcile` response into the rows the
 * PortfolioReconcile table renders.
 *
 * The server already decided *why* each discrepancy happened; this converts
 * that answer into table rows without re-deciding any of it, so the UI and the
 * API can never disagree about whether something is missing data or drift.
 */

import {
  RECONCILE_CAUSES,
  type ReconcileCauseCode,
  type ReconcileCauseSeverity,
} from "../../../../shared/types/reconcileCause";
import type { ReconcileAnomalyType, ReconcileRow } from "./PortfolioReconcile";

export interface ReconcileCauseResponseItem {
  code: ReconcileCauseCode;
  detail: string;
  assetId?: string;
  vaultId?: string;
  evidence?: {
    chainAssetId?: string;
    cachedAssetId?: string;
    chainAmount?: number;
    cachedAmount?: number;
    canonicalAsset?: string;
    staleDurationMs?: number;
    projectionVersion?: number;
    lastLedger?: number;
  };
}

export interface ReconcileResponse {
  status: "success" | "partial" | "failed";
  primaryCause: ReconcileCauseCode | null;
  causes: ReconcileCauseResponseItem[];
  isStale?: boolean;
}

const SEVERITY_TO_ROW: Record<ReconcileCauseSeverity, ReconcileRow["severity"]> = {
  info: "ok",
  warning: "warning",
  critical: "critical",
};

/** The legacy anomaly column, kept in step with the newer cause code. */
const CAUSE_TO_ANOMALY: Record<ReconcileCauseCode, ReconcileAnomalyType> = {
  MISSING_HOLDING: "missing",
  ORPHANED_HOLDING: "orphaned",
  SYMBOL_DRIFT: "missing",
  STALE_SOURCE: "stale",
  AMOUNT_DRIFT: "matched",
  DUPLICATE_POSITION: "duplicate",
  ORPHANED_TRANSACTION: "orphaned",
  SOURCE_UNAVAILABLE: "stale",
};

/**
 * `expected` is the cached side and `observed` the chain side, matching the
 * table's existing column meaning. A cause that is not position-specific — a
 * stale projection, an unreachable source — carries no amounts, so those cells
 * render as "—" rather than as a fabricated zero.
 */
export function toReconcileRows(response: ReconcileResponse): ReconcileRow[] {
  return response.causes.map((cause) => {
    const descriptor = RECONCILE_CAUSES[cause.code];
    const evidence = cause.evidence ?? {};

    const expected = evidence.cachedAmount ?? "—";
    const observed = evidence.chainAmount ?? null;
    const delta =
      typeof evidence.chainAmount === "number" && typeof evidence.cachedAmount === "number"
        ? evidence.chainAmount - evidence.cachedAmount
        : null;

    return {
      asset: cause.assetId ?? evidence.canonicalAsset ?? "—",
      vault: cause.vaultId ?? "—",
      expected,
      observed,
      delta,
      severity: SEVERITY_TO_ROW[descriptor.severity],
      anomalyType: CAUSE_TO_ANOMALY[cause.code],
      status: response.status === "failed" ? "unverified" : "confirmed",
      causeCode: cause.code,
      causeDetail: cause.detail,
      ...(evidence.lastLedger !== undefined ||
      evidence.projectionVersion !== undefined ||
      response.isStale
        ? {
            evidence: {
              ...(evidence.lastLedger !== undefined ? { ledger: evidence.lastLedger } : {}),
              ...(evidence.projectionVersion !== undefined
                ? { projectionVersion: String(evidence.projectionVersion) }
                : {}),
              ...(cause.vaultId ? { vault: cause.vaultId } : {}),
              isStaleCheckpoint: cause.code === "STALE_SOURCE",
            },
          }
        : {}),
    };
  });
}
