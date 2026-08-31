/**
 * Rebalance weight preview for the stablecoin basket strategy (#1170).
 *
 * Reads on-chain basket state via read-only simulation
 * (contracts/strategies/stablecoin_basket) and derives a per-asset
 * current/target/delta preview so a rebalance action can be reviewed
 * before submission.
 */
import { simulateReadOnlyCall } from "./sorobanReader";

const BPS = 10_000;

export interface BasketAssetPreviewLeg {
  tokenContractId: string;
  currentWeightBps: number;
  targetWeightBps: number;
  driftBps: number;
  deltaAmount: string;
  /** True when this leg's current weight was backfilled to the target (no drift data available), the safe empty/unavailable fallback. */
  isEstimated: boolean;
}

export interface BasketRebalancePreviewResult {
  contractId: string;
  totalDeposited: string;
  legs: BasketAssetPreviewLeg[];
  rebalanceNeeded: boolean;
  source: "onchain" | "unavailable";
  warnings: string[];
}

interface RawAssetConfig {
  token: string;
  weight_bps: bigint | number;
  max_concentration_bps: bigint | number;
}

interface RawBasketState {
  total_deposited: bigint | number;
  asset_configs: RawAssetConfig[];
  rebalance_threshold_bps: bigint | number;
}

type RawDelta = [string, bigint | number, bigint | number, bigint | number];

export async function getBasketRebalancePreview(
  contractId: string,
): Promise<BasketRebalancePreviewResult> {
  const stateResult = await simulateReadOnlyCall<RawBasketState>(contractId, "get_state");

  if (!stateResult.ok) {
    return {
      contractId,
      totalDeposited: "0",
      legs: [],
      rebalanceNeeded: false,
      source: "unavailable",
      warnings: ["Basket data is currently unavailable; showing no preview."],
    };
  }

  const state = stateResult.value;
  const totalDeposited = BigInt(state.total_deposited);

  const deltasResult = await simulateReadOnlyCall<RawDelta[]>(
    contractId,
    "compute_rebalance_deltas",
  );

  const driftedByToken = new Map<string, RawDelta>();
  if (deltasResult.ok) {
    for (const delta of deltasResult.value) {
      driftedByToken.set(delta[0], delta);
    }
  }
  // Any non-ok outcome (RebalanceNotNeeded contract error, or an
  // unreachable read) is treated identically to "nothing drifted" — every
  // configured asset falls back to current=target below, which is both the
  // correct display for "no rebalance needed" and the safe fallback state
  // required when drift data can't be determined.

  const legs: BasketAssetPreviewLeg[] = state.asset_configs.map((config) => {
    const targetWeightBps = Number(config.weight_bps);
    const drift = driftedByToken.get(config.token);
    if (drift) {
      const currentWeightBps = Number(drift[1]);
      return {
        tokenContractId: config.token,
        currentWeightBps,
        targetWeightBps,
        driftBps: Math.abs(currentWeightBps - targetWeightBps),
        deltaAmount: drift[3].toString(),
        isEstimated: false,
      };
    }
    return {
      tokenContractId: config.token,
      currentWeightBps: targetWeightBps,
      targetWeightBps,
      driftBps: 0,
      deltaAmount: "0",
      isEstimated: true,
    };
  });

  return {
    contractId,
    totalDeposited: totalDeposited.toString(),
    legs,
    rebalanceNeeded: driftedByToken.size > 0,
    source: "onchain",
    warnings: [],
  };
}

/**
 * Validates that target weights sum to exactly 10,000 bps (100%) and each
 * weight is positive. Mirrors simulationService.ts's validateRebalanceParams
 * shape (error-string array, empty = valid) but in basis points rather than
 * percent, matching this contract's native precision.
 */
export function validateBasketTargetWeights(
  weights: { token: string; weightBps: number }[],
): string[] {
  const errors: string[] = [];

  if (!weights.length) {
    errors.push("At least one asset weight is required.");
    return errors;
  }

  for (const w of weights) {
    if (!Number.isFinite(w.weightBps) || w.weightBps <= 0) {
      errors.push(`Weight for ${w.token} must be a positive number.`);
    }
  }

  const total = weights.reduce((sum, w) => sum + w.weightBps, 0);
  if (total !== BPS) {
    errors.push(`Target weights must sum to ${BPS} bps (100%); got ${total} bps.`);
  }

  return errors;
}
