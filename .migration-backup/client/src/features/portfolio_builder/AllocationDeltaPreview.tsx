/**
 * AllocationDeltaPreview
 *
 * Shows a before-and-after table of vault allocation changes so the user can
 * review what will change before they save. Computed entirely client-side from
 * the current (saved) and draft (slider-adjusted) allocations.
 *
 * - Highlights increases in green, decreases in red, unchanged rows in gray.
 * - Validates that the draft allocations sum to 100% and blocks submission
 *   with a clear message when they do not.
 * - Re-computes on every render so the preview is always in sync with the
 *   user's slider adjustments.
 */

import { useMemo } from "react";
import { TrendingUp, TrendingDown, Minus, AlertCircle, CheckCircle2 } from "lucide-react";
import type { VaultAllocation } from "./types";
import {
  computeAllocationDeltas,
  formatValueDelta,
  formatWeightDelta,
  type AllocationDeltaRow,
} from "./allocationDelta";

export interface AllocationDeltaPreviewProps {
  totalValueUsd: number;
  /** The saved (current) allocations — baseline for comparison. */
  savedAllocations: VaultAllocation[];
  /** The in-progress (draft) allocations being edited. */
  draftAllocations: VaultAllocation[];
  /**
   * Called when the user confirms they want to save the draft allocations.
   * Only enabled when the totals are valid.
   */
  onConfirm?: () => void;
  /** When true the confirm button is shown in a loading state. */
  isSaving?: boolean;
}

// ── Direction helpers ──────────────────────────────────────────────────────

const DIRECTION_CONFIG = {
  increase: {
    icon: TrendingUp,
    rowClass: "bg-green-500/5 border-l-2 border-green-500/40",
    deltaClass: "text-green-400",
    badge: "text-green-400",
  },
  decrease: {
    icon: TrendingDown,
    rowClass: "bg-red-500/5 border-l-2 border-red-500/40",
    deltaClass: "text-red-400",
    badge: "text-red-400",
  },
  unchanged: {
    icon: Minus,
    rowClass: "",
    deltaClass: "text-gray-500",
    badge: "text-gray-500",
  },
} as const;

// ── Sub-components ─────────────────────────────────────────────────────────

function DeltaRow({
  row,
  totalValueUsd,
}: {
  row: AllocationDeltaRow;
  totalValueUsd: number;
}) {
  const cfg = DIRECTION_CONFIG[row.direction];
  const Icon = cfg.icon;

  return (
    <tr className={`border-b border-white/5 transition-colors ${cfg.rowClass}`}>
      {/* Vault name */}
      <td className="py-2.5 pr-4 pl-2">
        <div className="flex items-center gap-2">
          <Icon
            size={14}
            className={cfg.badge}
            aria-label={row.direction}
          />
          <span className="font-medium text-sm">{row.vaultName}</span>
        </div>
      </td>

      {/* Previous weight */}
      <td className="py-2.5 pr-4 text-sm text-gray-400 tabular-nums">
        {row.previousWeight.toFixed(1)}%
        {totalValueUsd > 0 && (
          <span className="block text-xs text-gray-600">
            ${row.previousValueUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
        )}
      </td>

      {/* Next weight */}
      <td className="py-2.5 pr-4 text-sm tabular-nums">
        <span
          className={
            row.direction === "increase"
              ? "text-green-300 font-semibold"
              : row.direction === "decrease"
                ? "text-red-300 font-semibold"
                : "text-gray-300"
          }
        >
          {row.nextWeight.toFixed(1)}%
        </span>
        {totalValueUsd > 0 && (
          <span className="block text-xs text-gray-500">
            ${row.nextValueUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
        )}
      </td>

      {/* Weight delta */}
      <td className={`py-2.5 pr-4 text-sm tabular-nums ${cfg.deltaClass}`}>
        {row.direction === "unchanged" ? "—" : formatWeightDelta(row.weightDeltaPct)}
      </td>

      {/* USD delta */}
      <td className={`py-2.5 text-sm tabular-nums ${cfg.deltaClass}`}>
        {row.direction === "unchanged" || totalValueUsd === 0
          ? "—"
          : formatValueDelta(row.valueDeltaUsd)}
      </td>
    </tr>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function AllocationDeltaPreview({
  totalValueUsd,
  savedAllocations,
  draftAllocations,
  onConfirm,
  isSaving = false,
}: AllocationDeltaPreviewProps) {
  const summary = useMemo(
    () => computeAllocationDeltas(totalValueUsd, savedAllocations, draftAllocations),
    [totalValueUsd, savedAllocations, draftAllocations],
  );

  const { rows, totalIsValid, nextWeightTotal, hasChanges } = summary;

  return (
    <div className="glass-panel p-6 space-y-4" aria-label="Allocation change preview">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <span>Allocation Preview</span>
          {hasChanges ? (
            <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              Changes pending
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700/50 text-gray-400 border border-gray-600/30">
              No changes
            </span>
          )}
        </h3>
        {totalValueUsd > 0 && (
          <p className="text-xs text-gray-500">
            Total:{" "}
            <span className="text-gray-300 font-medium">
              ${totalValueUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </span>
          </p>
        )}
      </div>

      {/* Delta table */}
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-sm" aria-label="Allocation delta table">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-white/10">
              <th className="pb-2 pr-4 pl-2 font-medium">Vault</th>
              <th className="pb-2 pr-4 font-medium">Before</th>
              <th className="pb-2 pr-4 font-medium">After</th>
              <th className="pb-2 pr-4 font-medium">Δ Weight</th>
              <th className="pb-2 font-medium">Δ Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <DeltaRow
                key={row.vaultContractId}
                row={row}
                totalValueUsd={totalValueUsd}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Total validation */}
      {!totalIsValid ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/30 rounded-lg"
        >
          <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-red-400">Invalid total</p>
            <p className="text-xs text-red-300 mt-0.5">
              Allocations sum to{" "}
              <span className="font-mono font-bold">{nextWeightTotal.toFixed(2)}%</span> — they
              must equal exactly 100% before you can save.
            </p>
          </div>
        </div>
      ) : hasChanges ? (
        <div className="flex items-center gap-2 p-2.5 bg-green-500/10 border border-green-500/20 rounded-lg">
          <CheckCircle2 size={14} className="text-green-400 shrink-0" aria-hidden="true" />
          <p className="text-xs text-green-400">Allocations are valid and ready to save.</p>
        </div>
      ) : null}

      {/* Confirm button */}
      {onConfirm && (
        <button
          type="button"
          onClick={onConfirm}
          disabled={!totalIsValid || !hasChanges || isSaving}
          aria-disabled={!totalIsValid || !hasChanges || isSaving}
          className="w-full py-2 rounded-lg text-sm font-semibold transition-colors
            bg-indigo-600 hover:bg-indigo-500 text-white
            disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isSaving ? "Saving…" : "Save allocation changes"}
        </button>
      )}
    </div>
  );
}
