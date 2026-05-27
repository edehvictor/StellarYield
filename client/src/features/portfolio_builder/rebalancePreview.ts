/**
 * Rebalance Simulation Sandbox — client contract & presentation helpers.
 *
 * Mirrors the response shape of `POST /api/simulator/rebalance` and keeps the
 * request-building / presentation logic pure so it can be unit tested without
 * rendering a component or hitting the network. All calculations live on the
 * server; this module only shapes inputs and formats outputs.
 */

import type { VaultAllocation } from "./types";

export interface RebalanceAllocationInput {
  label: string;
  currentWeight: number;
  targetWeight: number;
  apy: number;
  liquidityUsd?: number;
}

export interface RebalanceRequest {
  totalValueUsd: number;
  allocations: RebalanceAllocationInput[];
}

export interface RebalanceLeg {
  label: string;
  currentWeight: number;
  targetWeight: number;
  driftPct: number;
  currentValueUsd: number;
  targetValueUsd: number;
  deltaUsd: number;
}

export interface RebalancePreview {
  isSimulationOnly: true;
  legs: RebalanceLeg[];
  blendedApyBefore: number;
  blendedApyAfter: number;
  apyDeltaPct: number;
  totalTurnoverUsd: number;
  estimatedFeeUsd: number;
  maxDriftPct: number;
  warnings: string[];
}

/**
 * Build a `/api/simulator/rebalance` request from the builder's current
 * baseline and the live (slider-adjusted) target allocations. Allocations are
 * matched by vault contract id; the target weights drive the rebalance.
 */
export function buildRebalanceRequest(
  totalValueUsd: number,
  current: VaultAllocation[],
  target: VaultAllocation[],
): RebalanceRequest {
  const currentByVault = new Map(
    current.map((a) => [a.vaultContractId, a.weight]),
  );

  return {
    totalValueUsd,
    allocations: target.map((a) => ({
      label: a.vaultName,
      currentWeight: currentByVault.get(a.vaultContractId) ?? 0,
      targetWeight: a.weight,
      apy: a.apy,
    })),
  };
}

export type ApyDirection = "up" | "down" | "flat";

export interface ApyDeltaSummary {
  direction: ApyDirection;
  deltaPct: number;
  label: string;
}

/** Describe the APY change so the UI can pick a colour/arrow without re-deriving it. */
export function summarizeApyDelta(preview: RebalancePreview): ApyDeltaSummary {
  const deltaPct = preview.apyDeltaPct;
  const direction: ApyDirection =
    deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat";
  const sign = deltaPct > 0 ? "+" : "";
  return {
    direction,
    deltaPct,
    label: `${sign}${deltaPct.toFixed(2)}%`,
  };
}

/** True when the preview surfaced any warning the operator should resolve first. */
export function hasWarnings(preview: RebalancePreview): boolean {
  return preview.warnings.length > 0;
}
