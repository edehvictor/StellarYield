/**
 * Stablecoin basket rebalance preview — client contract & presentation helpers.
 * Mirrors the response shape of
 * GET /api/strategies/stablecoin-basket/:contractId/rebalance-preview.
 * All calculations live on the server; this module only formats output and
 * runs the client-side pre-check that mirrors the server's weight-sum
 * validation.
 */

export interface BasketAssetPreviewLeg {
  tokenContractId: string;
  currentWeightBps: number;
  targetWeightBps: number;
  driftBps: number;
  deltaAmount: string;
  isEstimated: boolean;
}

export interface BasketRebalancePreview {
  contractId: string;
  totalDeposited: string;
  legs: BasketAssetPreviewLeg[];
  rebalanceNeeded: boolean;
  source: "onchain" | "unavailable";
  warnings: string[];
}

const BPS_TOTAL = 10_000;

/** bps -> percent string, e.g. 6000 -> "60.00%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Sum of a proposed set of target weights, in bps. */
export function sumTargetWeightBps(legs: { targetWeightBps: number }[]): number {
  return legs.reduce((sum, leg) => sum + leg.targetWeightBps, 0);
}

/**
 * Client-side mirror of the server's validateBasketTargetWeights check, so
 * the confirm action can be disabled before a round-trip — the server
 * remains the authority and re-validates on submission.
 */
export function isTargetWeightSumValid(legs: { targetWeightBps: number }[]): boolean {
  return sumTargetWeightBps(legs) === BPS_TOTAL;
}

export function hasUnavailableData(preview: BasketRebalancePreview): boolean {
  return preview.source === "unavailable";
}
