/**
 * DustAllocationWarning (#1378)
 *
 * Lists allocations that would receive dust (too small a weight, below the
 * minimum deposit, or zero after integer rounding) and offers a one-click
 * rebalance into the remaining vaults. Renders nothing when the portfolio is
 * clean, so the builder stays uncluttered in the normal path.
 */

import { AlertTriangle, Sparkles } from "lucide-react";
import type { DustValidationResult } from "../../../../shared/types/portfolioDust";

export interface DustAllocationWarningProps {
  validation: DustValidationResult;
  /** Called with rebalanced weights that remove the flagged allocations. */
  onAutoResolve?: () => void;
  /** True while the caller applies the suggested allocation. */
  isResolving?: boolean;
}

export default function DustAllocationWarning({
  validation,
  onAutoResolve,
  isResolving = false,
}: DustAllocationWarningProps) {
  if (validation.valid || validation.issues.length === 0) return null;

  const flaggedVaults = new Set(validation.issues.map((issue) => issue.vaultContractId));

  return (
    <div
      role="alert"
      data-testid="dust-allocation-warning"
      className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-yellow-400" />
        <div className="flex-1">
          <p className="font-medium text-yellow-200">Dust allocations detected</p>
          <p className="mt-0.5 text-xs text-yellow-100/70">
            {validation.message} Deposits below the minimum waste fees and can
            be rejected by the vault.
          </p>

          <ul className="mt-3 space-y-1.5">
            {validation.issues.map((issue) => (
              <li
                key={`${issue.vaultContractId}-${issue.code}`}
                className="text-xs text-yellow-100/80"
                data-testid={`dust-issue-${issue.code}`}
              >
                <span className="font-medium text-yellow-100">{issue.vaultName}</span>
                {" — "}
                {issue.message}
              </li>
            ))}
          </ul>

          <p className="mt-2 text-[11px] text-yellow-100/50">
            Minimum deposit: {validation.minimumAllocationAmount.toString()} base
            units · minimum non-zero weight:{" "}
            {validation.minNonZeroWeightPct.toString()}% ·{" "}
            {flaggedVaults.size} vault{flaggedVaults.size === 1 ? "" : "s"} affected
          </p>

          {onAutoResolve && validation.suggestedAllocations && (
            <button
              type="button"
              onClick={onAutoResolve}
              disabled={isResolving}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-yellow-500/20 px-3 py-1.5 text-xs font-medium text-yellow-100 hover:bg-yellow-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {isResolving ? "Rebalancing…" : "Remove dust & rebalance"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
