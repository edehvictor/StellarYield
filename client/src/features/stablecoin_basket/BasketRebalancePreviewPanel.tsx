/**
 * Stablecoin basket rebalance weight preview (#1170).
 * Read-only preview of a basket's current vs. target weights before a
 * rebalance action is submitted, plus a safe fallback banner when basket
 * data is empty or unavailable.
 */

import { useCallback, useState } from "react";
import { AlertTriangle, FlaskConical } from "lucide-react";
import { apiUrl } from "../../lib/api";
import {
  formatBps,
  hasUnavailableData,
  isTargetWeightSumValid,
  sumTargetWeightBps,
  type BasketRebalancePreview,
} from "./basketRebalancePreview";

export interface BasketRebalancePreviewPanelProps {
  contractId: string;
  disabled?: boolean;
  onPreviewChange?: (preview: BasketRebalancePreview | null) => void;
}

export default function BasketRebalancePreviewPanel({
  contractId,
  disabled = false,
  onPreviewChange,
}: BasketRebalancePreviewPanelProps) {
  const [preview, setPreview] = useState<BasketRebalancePreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPreview = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch(
        apiUrl(`/api/strategies/stablecoin-basket/${contractId}/rebalance-preview`)
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ? String(data.error) : `HTTP ${res.status}`);
      }
      const typed = data as BasketRebalancePreview;
      setPreview(typed);
      onPreviewChange?.(typed);
    } catch (err) {
      console.error("Basket rebalance preview failed:", err);
      setPreview(null);
      onPreviewChange?.(null);
      setError(err instanceof Error ? err.message : "Failed to preview rebalance");
    } finally {
      setIsLoading(false);
    }
  }, [contractId, onPreviewChange]);

  const targetSumBps = preview ? sumTargetWeightBps(preview.legs) : 0;
  const targetSumValid = preview ? isTargetWeightSumValid(preview.legs) : true;

  return (
    <div className="glass-panel p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical size={20} className="text-indigo-400" />
          <h3 className="text-lg font-semibold">Rebalance Preview</h3>
        </div>
        <button
          type="button"
          onClick={runPreview}
          disabled={disabled || isLoading}
          className="text-sm bg-white/10 hover:bg-white/20 disabled:opacity-50 px-3 py-1.5 rounded-lg"
        >
          {isLoading ? "Previewing…" : "Preview rebalance"}
        </button>
      </div>

      <p className="text-xs text-gray-500">
        Preview only — shows how basket weights would change before any
        rebalance is submitted.
      </p>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-red-500" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {preview && hasUnavailableData(preview) && (
        <div className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
          <span className="text-sm text-yellow-400">
            Basket data is currently unavailable. Showing a safe empty state — no
            preview to review yet.
          </span>
        </div>
      )}

      {preview && !hasUnavailableData(preview) && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-white/10">
                  <th className="py-2 pr-4 font-medium">Asset</th>
                  <th className="py-2 pr-4 font-medium">Before</th>
                  <th className="py-2 pr-4 font-medium">After</th>
                  <th className="py-2 font-medium">Drift</th>
                </tr>
              </thead>
              <tbody>
                {preview.legs.map((leg) => (
                  <tr key={leg.tokenContractId} className="border-b border-white/5">
                    <td className="py-2 pr-4 font-medium">
                      {leg.tokenContractId.slice(0, 8)}…
                    </td>
                    <td className="py-2 pr-4 text-gray-400">
                      {formatBps(leg.currentWeightBps)}
                    </td>
                    <td className="py-2 pr-4">{formatBps(leg.targetWeightBps)}</td>
                    <td
                      className={`py-2 ${leg.driftBps > 0 ? "text-yellow-400" : "text-gray-400"}`}
                    >
                      {leg.driftBps > 0 ? formatBps(leg.driftBps) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!targetSumValid && (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
              <span className="text-sm text-red-400">
                Target weights sum to {formatBps(targetSumBps)}, not 100%. Cannot
                submit until this is resolved.
              </span>
            </div>
          )}

          {preview.warnings.map((warning) => (
            <div
              key={warning}
              className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg"
            >
              <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
              <span className="text-sm text-yellow-400">{warning}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
