/**
 * Rebalance Simulation Sandbox
 *
 * Read-only preview of moving from the builder's baseline allocation to the
 * slider-adjusted target: before/after weights, blended APY, estimated
 * turnover fees, and warnings for high fees / stale data / liquidity risk.
 * Calls the backend sandbox endpoint — it never commits capital.
 */

import { useCallback, useState } from "react";
import { TrendingUp, TrendingDown, Minus, AlertTriangle, FlaskConical } from "lucide-react";
import { apiUrl } from "../../lib/api";
import type { VaultAllocation } from "./types";
import {
  buildRebalanceRequest,
  summarizeApyDelta,
  hasWarnings,
  type RebalancePreview as RebalancePreviewData,
} from "./rebalancePreview";

export interface RebalancePreviewProps {
  totalValueUsd: number;
  currentAllocations: VaultAllocation[];
  targetAllocations: VaultAllocation[];
  disabled?: boolean;
}

export default function RebalancePreview({
  totalValueUsd,
  currentAllocations,
  targetAllocations,
  disabled = false,
}: RebalancePreviewProps) {
  const [preview, setPreview] = useState<RebalancePreviewData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPreview = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const body = buildRebalanceRequest(
        totalValueUsd,
        currentAllocations,
        targetAllocations,
      );
      const res = await fetch(apiUrl("/api/simulator/rebalance"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const details = Array.isArray(data?.details)
          ? data.details.join(" ")
          : "";
        throw new Error(data?.error ? `${data.error}. ${details}`.trim() : `HTTP ${res.status}`);
      }
      setPreview(data as RebalancePreviewData);
    } catch (err) {
      console.error("Rebalance preview failed:", err);
      setPreview(null);
      setError(err instanceof Error ? err.message : "Failed to preview rebalance");
    } finally {
      setIsLoading(false);
    }
  }, [totalValueUsd, currentAllocations, targetAllocations]);

  const apyDelta = preview ? summarizeApyDelta(preview) : null;
  const DeltaIcon =
    apyDelta?.direction === "up"
      ? TrendingUp
      : apyDelta?.direction === "down"
        ? TrendingDown
        : Minus;
  const deltaColor =
    apyDelta?.direction === "up"
      ? "text-green-400"
      : apyDelta?.direction === "down"
        ? "text-red-400"
        : "text-gray-400";

  return (
    <div className="glass-panel p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FlaskConical size={20} className="text-indigo-400" />
          <h3 className="text-lg font-semibold">Rebalance Preview (Sandbox)</h3>
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
        Simulation only — previews the effect of your target allocation before
        any capital moves.
      </p>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-red-500" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {preview && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric label="Blended APY (before)" value={`${preview.blendedApyBefore.toFixed(2)}%`} />
            <Metric label="Blended APY (after)" value={`${preview.blendedApyAfter.toFixed(2)}%`} />
            <div className="p-3 bg-black/30 rounded-lg">
              <p className="text-xs text-gray-400">APY change</p>
              <p className={`text-lg font-semibold flex items-center gap-1 ${deltaColor}`}>
                <DeltaIcon className="w-4 h-4" />
                {apyDelta?.label}
              </p>
            </div>
            <Metric label="Est. fees" value={`$${preview.estimatedFeeUsd.toFixed(2)}`} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-white/10">
                  <th className="py-2 pr-4 font-medium">Vault</th>
                  <th className="py-2 pr-4 font-medium">Before</th>
                  <th className="py-2 pr-4 font-medium">After</th>
                  <th className="py-2 pr-4 font-medium">Drift</th>
                  <th className="py-2 font-medium">Δ Value</th>
                </tr>
              </thead>
              <tbody>
                {preview.legs.map((leg) => (
                  <tr key={leg.label} className="border-b border-white/5">
                    <td className="py-2 pr-4 font-medium">{leg.label}</td>
                    <td className="py-2 pr-4 text-gray-400">
                      {leg.currentWeight.toFixed(1)}%
                    </td>
                    <td className="py-2 pr-4">{leg.targetWeight.toFixed(1)}%</td>
                    <td
                      className={`py-2 pr-4 ${leg.driftPct > 0 ? "text-green-400" : leg.driftPct < 0 ? "text-red-400" : "text-gray-400"}`}
                    >
                      {leg.driftPct > 0 ? "+" : ""}
                      {leg.driftPct.toFixed(1)}%
                    </td>
                    <td className="py-2 text-gray-400">
                      {leg.deltaUsd >= 0 ? "+" : "−"}$
                      {Math.abs(leg.deltaUsd).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasWarnings(preview) && (
            <div className="space-y-2">
              {preview.warnings.map((warning) => (
                <div
                  key={warning}
                  className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg"
                >
                  <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                  <span className="text-sm text-yellow-400">{warning}</span>
                </div>
              ))}
            </div>
          )}
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
