/**
 * Allocation rollback preview panel (#1360).
 *
 * Read-only operator panel that previews what rolling back a vault's latest
 * pending rebalance would change. Handles all four UI states:
 *   - loading  — request in flight, refresh button disabled
 *   - empty    — no pending rebalance to roll back (NO_PENDING_REBALANCE)
 *   - failure  — any other typed server error, surfaced via role="alert"
 *   - success  — deterministic per-key weight diff with safety indicator
 */

import { useCallback, useState } from "react";
import { History, RefreshCw, AlertTriangle, ShieldCheck, ShieldAlert } from "lucide-react";
import {
  AllocationRollbackPreviewService,
  AllocationRollbackPreviewServiceError,
} from "../../services/allocationRollbackPreviewService";
import type { AllocationRollbackPreview } from "../../../../shared/types/allocationRollback";

interface AllocationRollbackPreviewPanelProps {
  vaultId: string;
}

function formatWeight(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatDelta(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

export default function AllocationRollbackPreviewPanel({
  vaultId,
}: AllocationRollbackPreviewPanelProps) {
  const [preview, setPreview] = useState<AllocationRollbackPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEmpty, setIsEmpty] = useState(false);

  const loadPreview = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      setIsEmpty(false);
      const result = await AllocationRollbackPreviewService.fetchPendingPreview(vaultId);
      setPreview(result);
    } catch (err) {
      setPreview(null);
      if (
        err instanceof AllocationRollbackPreviewServiceError &&
        err.code === "NO_PENDING_REBALANCE"
      ) {
        setIsEmpty(true);
      } else if (err instanceof AllocationRollbackPreviewServiceError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load rollback preview.");
      }
    } finally {
      setIsLoading(false);
    }
  }, [vaultId]);

  return (
    <div
      className="glass-panel p-6 space-y-4"
      data-testid="allocation-rollback-preview-panel"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History size={20} className="text-indigo-400" />
          <h2 className="text-xl font-semibold">Allocation Rollback Preview</h2>
        </div>
        <button
          type="button"
          onClick={loadPreview}
          disabled={isLoading}
          aria-label="Preview rollback"
          className="flex items-center gap-2 text-sm text-gray-300 hover:text-white disabled:opacity-50"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
          {isLoading ? "Loading…" : "Preview rollback"}
        </button>
      </div>

      <p className="text-sm text-gray-500">
        Read-only, deterministic preview of rolling back the latest pending
        rebalance for <span className="text-gray-300">{vaultId}</span>. Nothing
        is executed.
      </p>

      {error && (
        <div
          role="alert"
          data-testid="allocation-rollback-error"
          className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg"
        >
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {isEmpty && !error && (
        <div
          data-testid="allocation-rollback-empty"
          className="flex items-center gap-2 p-3 bg-gray-500/10 border border-gray-500/30 rounded-lg"
        >
          <History className="w-5 h-5 text-gray-400 shrink-0" />
          <span className="text-sm text-gray-400">
            No pending rebalance to roll back for this vault.
          </span>
        </div>
      )}

      {isLoading && !preview && !error && (
        <p className="text-sm text-gray-400" data-testid="allocation-rollback-loading">
          Loading rollback preview…
        </p>
      )}

      {preview && (
        <div className="space-y-4" data-testid="allocation-rollback-result">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {preview.safe ? (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-green-500/15 text-green-400">
                <ShieldCheck size={14} /> No queue conflicts
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-yellow-500/15 text-yellow-400">
                <ShieldAlert size={14} /> {preview.conflictingQueueEntryIds.length}{" "}
                conflicting queue entr
                {preview.conflictingQueueEntryIds.length === 1 ? "y" : "ies"}
              </span>
            )}
            {preview.noOp && (
              <span className="inline-flex items-center px-2 py-1 rounded-lg bg-gray-500/15 text-gray-300">
                No-op: weights already match
              </span>
            )}
            <span className="text-xs text-gray-500 font-mono">
              {preview.inputHash.slice(0, 12)}
            </span>
          </div>

          {preview.changes.length === 0 ? (
            <p className="text-sm text-gray-500">No allocation keys to display.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-700">
                  <th className="py-2 pr-3">Allocation</th>
                  <th className="py-2 pr-3 text-right">Current</th>
                  <th className="py-2 pr-3 text-right">Rollback</th>
                  <th className="py-2 text-right">Δ</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((change) => (
                  <tr
                    key={change.vaultId}
                    className="border-b border-gray-800/60"
                    data-testid="allocation-rollback-row"
                  >
                    <td className="py-2 pr-3 text-gray-200">{change.vaultId}</td>
                    <td className="py-2 pr-3 text-right text-gray-400">
                      {formatWeight(change.currentWeight)}
                    </td>
                    <td className="py-2 pr-3 text-right text-gray-200">
                      {formatWeight(change.rollbackWeight)}
                    </td>
                    <td
                      className={`py-2 text-right font-semibold ${
                        change.deltaWeight > 0
                          ? "text-green-400"
                          : change.deltaWeight < 0
                            ? "text-red-400"
                            : "text-gray-500"
                      }`}
                    >
                      {formatDelta(change.deltaWeight)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {preview.rollbackReason && (
            <p className="text-xs text-gray-500">Reason: {preview.rollbackReason}</p>
          )}
        </div>
      )}
    </div>
  );
}
