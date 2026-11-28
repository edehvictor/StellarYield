/**
 * YieldDiagnosticNotice (#1877)
 *
 * Renders a `ResolvedYieldDiagnostic` for the yield data display: what failed,
 * at which stage, and what the user can do about it. All copy comes from the
 * shared diagnostic catalog, never from raw response text or exceptions.
 *
 * Two layouts:
 * - full (default): nothing else to show; replaces the data view.
 * - `showingLastRates`: a banner above the last rates that loaded, which stay
 *   on screen.
 *
 * When the stage is unknown the notice says so and offers no remediation,
 * only the support reference.
 */
import { AlertCircle, AlertTriangle, RefreshCw, Activity } from "lucide-react";
import { openDiagnosticsPanel } from "../../lib/config";
import type {
  ResolvedYieldDiagnostic,
  YieldFailureStage,
} from "../../../../shared/types/yieldDiagnostics";

export const YIELD_STAGE_LABELS: Record<YieldFailureStage, string> = {
  input_validation: "Request validation",
  source_retrieval: "Loading yield sources",
  reliability_scoring: "Source health check",
  yield_enrichment: "Net yield calculation",
  response_serialization: "Preparing the response",
  network: "Connecting to the yield service",
  response_parsing: "Reading the response",
  unknown: "Could not be determined",
};

export interface YieldDiagnosticNoticeProps {
  diagnostic: ResolvedYieldDiagnostic;
  onRetry?: () => void;
  retrying?: boolean;
  /** True when previously loaded rates are still displayed below. */
  showingLastRates?: boolean;
  /** Feature name used in the full-layout heading. */
  featureName?: string;
}

export function YieldDiagnosticNotice({
  diagnostic,
  onRetry,
  retrying = false,
  showingLastRates = false,
  featureName = "APY Data",
}: YieldDiagnosticNoticeProps) {
  const stageLabel = YIELD_STAGE_LABELS[diagnostic.stage] ?? YIELD_STAGE_LABELS.unknown;
  const canRetry = diagnostic.retryable && onRetry !== undefined;
  const Icon = showingLastRates ? AlertTriangle : AlertCircle;

  return (
    <section
      role={showingLastRates ? "status" : "alert"}
      aria-labelledby="yield-diagnostic-title"
      data-testid="yield-diagnostic"
      data-stage={diagnostic.stage}
      data-code={diagnostic.code}
      className={
        showingLastRates
          ? "glass-panel border border-amber-500/30 bg-amber-500/10 p-4 space-y-2"
          : "glass-panel p-8 border border-amber-500/30 bg-amber-500/5 rounded-lg space-y-3"
      }
    >
      <div className="flex items-start gap-3">
        <Icon size={showingLastRates ? 16 : 24} className="text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="space-y-1 min-w-0">
          <h3 id="yield-diagnostic-title" className="font-semibold text-amber-100">
            {showingLastRates
              ? "Live APY refresh failed. Showing the last available rates."
              : `${featureName} Temporarily Unavailable`}
          </h3>
          <p className="text-sm font-medium text-amber-200">{diagnostic.title}</p>
          <p className="text-sm text-gray-300">{diagnostic.summary}</p>
          <p className="text-sm text-gray-400">
            <span className="font-medium text-gray-300">Failed step: </span>
            {stageLabel}
          </p>
          {diagnostic.remediation ? (
            <p className="text-sm text-gray-300">
              <span className="font-medium">What to do: </span>
              {diagnostic.remediation}
            </p>
          ) : (
            <p className="text-sm text-gray-400">
              There is not enough information to suggest a specific fix. If this
              keeps happening, contact support with the reference below.
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {canRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="btn-secondary inline-flex items-center gap-2 text-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={retrying ? "animate-spin" : ""} aria-hidden="true" />
            {retrying ? "Retrying..." : "Retry"}
          </button>
        )}
        <button
          type="button"
          onClick={() => openDiagnosticsPanel()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm border border-slate-700"
        >
          <Activity size={14} className="text-indigo-400" aria-hidden="true" />
          Check Diagnostics
        </button>
      </div>

      <details className="text-xs text-gray-500">
        <summary className="cursor-pointer select-none">Technical details</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>Code</dt>
          <dd className="font-mono">{diagnostic.code}</dd>
          <dt>Stage</dt>
          <dd className="font-mono">{diagnostic.stage}</dd>
          {diagnostic.httpStatus !== undefined && (
            <>
              <dt>HTTP status</dt>
              <dd className="font-mono">{diagnostic.httpStatus}</dd>
            </>
          )}
          <dt>Reference</dt>
          <dd className="font-mono break-all">{diagnostic.requestId ?? "not available"}</dd>
        </dl>
      </details>
    </section>
  );
}

export default YieldDiagnosticNotice;
