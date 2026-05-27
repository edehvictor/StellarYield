/**
 * Contract Event Indexer — Replay Checkpoint Panel
 *
 * Operator-facing, read-only view of the event indexer: latest indexed ledger
 * (replay checkpoint), latest network ledger, lag from Horizon, and recent
 * replay errors. Surfaces a degraded/unavailable banner when the indexer
 * falls behind.
 */

import { useCallback, useEffect, useState } from "react";
import { Database, RefreshCw, AlertTriangle } from "lucide-react";
import StatusBadge from "../../components/StatusBadge";
import { apiUrl } from "../../lib/api";
import {
  getIndexerStatusDisplay,
  formatLag,
  isIndexerDegraded,
  type IndexerStatus,
} from "./indexerStatus";

export default function IndexerCheckpointPanel() {
  const [status, setStatus] = useState<IndexerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch(apiUrl("/api/indexer/status"));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await res.json();
      setStatus(body.data as IndexerStatus);
    } catch (err) {
      console.error("Failed to fetch indexer status:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch indexer status");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const display = status ? getIndexerStatusDisplay(status.status) : null;

  return (
    <div className="glass-panel p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database size={20} className="text-indigo-400" />
          <h2 className="text-xl font-semibold">Event Indexer Checkpoint</h2>
        </div>
        <button
          type="button"
          onClick={fetchStatus}
          disabled={isLoading}
          aria-label="Refresh indexer status"
          className="flex items-center gap-2 text-sm text-gray-300 hover:text-white disabled:opacity-50"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {!error && isLoading && !status && (
        <p className="text-sm text-gray-400">Loading indexer status…</p>
      )}

      {status && display && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge variant={display.variant} label={display.label} />
            <span className="text-sm text-gray-400">{formatLag(status.lagLedgers)}</span>
          </div>

          {isIndexerDegraded(status) && status.reason && (
            <div className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-yellow-500" />
              <span className="text-sm text-yellow-400">{status.reason}</span>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Metric
              label="Replay checkpoint"
              value={status.indexedLedger !== null ? `#${status.indexedLedger}` : "—"}
            />
            <Metric
              label="Network ledger"
              value={status.horizonLedger !== null ? `#${status.horizonLedger}` : "—"}
            />
            <Metric
              label="Lag (ledgers)"
              value={status.lagLedgers !== null ? String(status.lagLedgers) : "—"}
            />
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-300 mb-2">
              Recent replay errors
            </h3>
            {status.recentErrors.length === 0 ? (
              <p className="text-sm text-gray-500">No recent replay errors.</p>
            ) : (
              <ul className="space-y-1">
                {status.recentErrors.map((err, idx) => (
                  <li
                    key={`${err.at}-${idx}`}
                    className="text-xs text-red-300 bg-red-500/5 border border-red-500/20 rounded px-2 py-1"
                  >
                    <span className="text-gray-500">
                      {new Date(err.at).toLocaleTimeString()}
                      {err.ledger !== null ? ` · #${err.ledger}` : ""}
                    </span>{" "}
                    {err.message}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs text-gray-500">
            Generated {new Date(status.generatedAt).toLocaleString()} · read-only
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 bg-black/30 rounded-lg">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
