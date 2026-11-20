import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle, Loader2, RefreshCw, Scale, XCircle } from "lucide-react";
import { getContractId } from "../../services/contractRegistry";
import {
  fetchLatestSharePriceReconciliation,
  SharePriceReconError,
  type SharePriceReconLookup,
  type SharePriceReconRun,
} from "./fetchSharePriceReconciliation";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; error: SharePriceReconError }
  | { phase: "loaded"; lookup: SharePriceReconLookup };

type Props = {
  /** Vault contract id; defaults to the registry's vault for the active network. */
  vaultId?: string;
  /** Injectable for tests. */
  fetchLatest?: (vaultId: string) => Promise<SharePriceReconLookup>;
};

const STATUS_VIEW: Record<
  SharePriceReconRun["status"],
  { label: string; className: string; icon: ReactNode }
> = {
  success: {
    label: "In sync",
    className: "text-green-400 bg-green-500/20",
    icon: <CheckCircle size={14} />,
  },
  partial: {
    label: "Drift detected",
    className: "text-yellow-400 bg-yellow-500/20",
    icon: <AlertTriangle size={14} />,
  },
  failed: {
    label: "Check failed",
    className: "text-red-400 bg-red-500/20",
    icon: <XCircle size={14} />,
  },
};

function formatPrice(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(6) : "—";
}

function formatPct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function toError(error: unknown): SharePriceReconError {
  return error instanceof SharePriceReconError
    ? error
    : new SharePriceReconError("Unexpected error loading reconciliation.", "HTTP_ERROR", 0);
}

/**
 * Latest share-price reconciliation between the YieldVault's contract events
 * and the backend share-price cache. Read-only: runs are produced by the
 * server (`POST /api/vaults/:vaultId/share-price/reconcile`).
 */
export default function VaultSharePriceReconcilePanel({
  vaultId = getContractId("vault"),
  fetchLatest = fetchLatestSharePriceReconciliation,
}: Props) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!vaultId) return;
    let cancelled = false;
    setState({ phase: "loading" });
    fetchLatest(vaultId).then(
      (lookup) => !cancelled && setState({ phase: "loaded", lookup }),
      (error: unknown) => !cancelled && setState({ phase: "error", error: toError(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [vaultId, fetchLatest, attempt]);

  const header = (
    <h3 className="font-semibold text-white mb-1 flex items-center gap-2">
      <Scale size={18} /> Vault Share Price Reconciliation
    </h3>
  );

  if (!vaultId) {
    return (
      <div className="glass-panel rounded-2xl p-6" data-testid="share-price-recon-unconfigured">
        {header}
        <p className="text-sm text-gray-400">
          No vault contract is configured for this network, so there is nothing to reconcile.
        </p>
      </div>
    );
  }

  if (state.phase === "loading") {
    return (
      <div
        className="glass-panel rounded-2xl p-6 flex items-center justify-center py-12"
        data-testid="share-price-recon-loading"
      >
        <Loader2 size={28} className="text-indigo-400 animate-spin" aria-label="Loading" />
      </div>
    );
  }

  if (state.phase === "error") {
    const { error } = state;
    return (
      <div className="glass-panel rounded-2xl p-6" data-testid="share-price-recon-error" data-error-code={error.code}>
        {header}
        <p className="text-sm text-red-400">
          {error.code === "CACHE_UNAVAILABLE"
            ? "The share-price cache is unreachable right now."
            : error.code === "NETWORK_ERROR"
              ? "Could not reach the reconciliation service."
              : "Reconciliation results could not be loaded."}
        </p>
        {error.retryable && (
          <button
            type="button"
            onClick={retry}
            className="mt-3 inline-flex items-center gap-1 text-sm text-indigo-300 hover:text-indigo-200"
          >
            <RefreshCw size={14} /> Retry
          </button>
        )}
      </div>
    );
  }

  if (state.lookup.kind === "empty") {
    return (
      <div className="glass-panel rounded-2xl p-6" data-testid="share-price-recon-empty">
        {header}
        <p className="text-sm text-gray-400">
          No reconciliation has run for this vault yet.
        </p>
      </div>
    );
  }

  const { run } = state.lookup;
  const view = STATUS_VIEW[run.status];

  return (
    <div className="glass-panel rounded-2xl p-6" data-testid="share-price-recon-result" data-status={run.status}>
      <div className="flex items-start justify-between gap-3">
        {header}
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${view.className}`}>
          {view.icon} {view.label}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Last checked {new Date(run.timestamp).toLocaleString()}
        {run.contractState && ` · ${run.contractState.eventCount} events through ledger ${run.contractState.lastLedger}`}
      </p>

      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div className="rounded-xl bg-gray-800/50 border border-gray-700/50 p-3">
          <dt className="text-gray-400 text-xs">Contract share price</dt>
          <dd className="text-white font-mono" data-testid="contract-share-price">
            {formatPrice(run.contractSharePrice)}
          </dd>
        </div>
        <div className="rounded-xl bg-gray-800/50 border border-gray-700/50 p-3">
          <dt className="text-gray-400 text-xs">Cached share price</dt>
          <dd className="text-white font-mono" data-testid="cached-share-price">
            {formatPrice(run.cachedState?.sharePrice)}
          </dd>
        </div>
        <div className="rounded-xl bg-gray-800/50 border border-gray-700/50 p-3">
          <dt className="text-gray-400 text-xs">Max drift</dt>
          <dd className="text-white font-mono" data-testid="max-drift">
            {formatPct(run.maxDriftPct)}
          </dd>
        </div>
      </dl>

      {run.causes.length > 0 && (
        <ul className="mt-4 space-y-2" data-testid="share-price-recon-causes">
          {run.causes.map((c, i) => (
            <li
              key={`${c.code}-${i}`}
              data-cause={c.code}
              className="rounded-lg border border-gray-700/50 bg-gray-800/30 p-3 text-sm"
              title={`Fix: ${c.remediation}`}
            >
              <span className="font-medium text-white">{c.title}</span>
              <span className="block text-xs text-gray-400">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
