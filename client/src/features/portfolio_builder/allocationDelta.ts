/**
 * Allocation Delta Utilities
 *
 * Pure calculation helpers for computing before-and-after differences between
 * two allocation snapshots. Used by AllocationDeltaPreview to show percentage
 * and USD value changes before the user saves a vault allocation update.
 */

import type { VaultAllocation } from "./types";

export type DeltaDirection = "increase" | "decrease" | "unchanged";

export interface AllocationDeltaRow {
  vaultContractId: string;
  vaultName: string;
  /** Weight before the edit, 0-100. */
  previousWeight: number;
  /** Weight after the edit, 0-100. */
  nextWeight: number;
  /** Absolute percentage-point change (nextWeight - previousWeight). */
  weightDeltaPct: number;
  /** USD value before the edit. */
  previousValueUsd: number;
  /** USD value after the edit. */
  nextValueUsd: number;
  /** Absolute USD change (nextValueUsd - previousValueUsd). */
  valueDeltaUsd: number;
  direction: DeltaDirection;
}

export interface AllocationDeltaSummary {
  rows: AllocationDeltaRow[];
  /** True when the next allocations sum to 100% (within floating-point tolerance). */
  totalIsValid: boolean;
  /** The actual sum of next weights — useful for the error message. */
  nextWeightTotal: number;
  /** True when at least one row differs from the previous allocation. */
  hasChanges: boolean;
}

const EPSILON = 1e-6;

/**
 * Compute per-row allocation deltas between two snapshots matched by
 * `vaultContractId`. Vaults that appear only in `next` are treated as new
 * positions (previousWeight = 0); vaults that appear only in `previous` are
 * treated as removed (nextWeight = 0).
 */
export function computeAllocationDeltas(
  totalValueUsd: number,
  previous: VaultAllocation[],
  next: VaultAllocation[],
): AllocationDeltaSummary {
  const previousMap = new Map(previous.map((a) => [a.vaultContractId, a]));
  const nextMap = new Map(next.map((a) => [a.vaultContractId, a]));

  // Stable insertion order: prev vaults first, then any new-only vaults.
  const allIds = [
    ...previous.map((a) => a.vaultContractId),
    ...next
      .filter((a) => !previousMap.has(a.vaultContractId))
      .map((a) => a.vaultContractId),
  ];

  const rows: AllocationDeltaRow[] = allIds.map((id) => {
    const prev = previousMap.get(id);
    const cur = nextMap.get(id);

    const vaultName = (prev ?? cur)!.vaultName;
    const previousWeight = prev?.weight ?? 0;
    const nextWeight = cur?.weight ?? 0;
    const previousValueUsd = (previousWeight / 100) * totalValueUsd;
    const nextValueUsd = (nextWeight / 100) * totalValueUsd;
    const weightDeltaPct = nextWeight - previousWeight;
    const valueDeltaUsd = nextValueUsd - previousValueUsd;

    let direction: DeltaDirection = "unchanged";
    if (weightDeltaPct > EPSILON) direction = "increase";
    else if (weightDeltaPct < -EPSILON) direction = "decrease";

    return {
      vaultContractId: id,
      vaultName,
      previousWeight,
      nextWeight,
      weightDeltaPct,
      previousValueUsd,
      nextValueUsd,
      valueDeltaUsd,
      direction,
    };
  });

  const nextWeightTotal = next.reduce((s, a) => s + a.weight, 0);
  const totalIsValid = Math.abs(nextWeightTotal - 100) < EPSILON;
  const hasChanges = rows.some((r) => r.direction !== "unchanged");

  return { rows, totalIsValid, nextWeightTotal, hasChanges };
}

/** Format a signed USD delta for display, e.g. "+$1,234.56" or "−$500.00". */
export function formatValueDelta(delta: number): string {
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(delta).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a signed weight delta for display, e.g. "+5.0pp" or "−3.5pp". */
export function formatWeightDelta(delta: number): string {
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}${Math.abs(delta).toFixed(1)}pp`;
}
