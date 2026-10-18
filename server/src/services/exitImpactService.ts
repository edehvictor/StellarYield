export interface ExitImpactEstimate {
  estimatedReceivedUsd: number;
  priceImpactPct: number;
  feeDragUsd: number;
  liquidityDepthUsd: number;
  isLowLiquidity: boolean;
  optimisticAmountUsd: number;
  conservativeAmountUsd: number;
}

export interface ReserveImpactPreview {
  /** Reserve / TVL ratio before the withdrawal, as a percentage. */
  currentReserveRatioPct: number;
  /** Reserve / TVL ratio the vault would have after the withdrawal, as a percentage. */
  projectedReserveRatioPct: number;
  /** Absolute reserve USD remaining after the withdrawal (never negative). */
  projectedReserveUsd: number;
  /** True if the projected ratio would fall below minBufferPct. */
  breachesMinBuffer: boolean;
  /** The minimum reserve buffer threshold used for the breach check, as a percentage. */
  minBufferPct: number;
}

export class ExitImpactService {
  /**
   * Estimates the impact of withdrawing a certain amount from a vault.
   * 
   * @param amountUsd - The amount to withdraw in USD.
   * @param poolLiquidityUsd - The total liquidity available in the underlying pools.
   * @param exitFeeBps - The withdrawal fee in basis points.
   * @returns Exit impact estimate.
   */
  public static estimateImpact(
    amountUsd: number,
    poolLiquidityUsd: number,
    exitFeeBps: number = 0
  ): ExitImpactEstimate {
    // Simple constant product-like price impact model: impact = amount / (liquidity + amount)
    const priceImpact = amountUsd / (poolLiquidityUsd + amountUsd);
    const feeDrag = (amountUsd * exitFeeBps) / 10000;
    
    const baseReceived = amountUsd - feeDrag;
    const actualReceived = baseReceived * (1 - priceImpact);

    // Optimistic: lower slippage, Conservative: higher slippage
    const optimisticSlippage = priceImpact * 0.5;
    const conservativeSlippage = priceImpact * 1.5;

    return {
      estimatedReceivedUsd: actualReceived,
      priceImpactPct: priceImpact * 100,
      feeDragUsd: feeDrag,
      liquidityDepthUsd: poolLiquidityUsd,
      isLowLiquidity: priceImpact > 0.02, // Warn if price impact > 2%
      optimisticAmountUsd: baseReceived * (1 - optimisticSlippage),
      conservativeAmountUsd: baseReceived * (1 - conservativeSlippage),
    };
  }

  /**
   * Projects what a vault's reserve ratio (idle reserve / TVL) would become
   * after a hypothetical withdrawal, without executing anything. Read-only,
   * matching this route's existing "quote, don't act" contract.
   *
   * @param currentReserveUsd - The vault's current idle reserve in USD.
   * @param vaultTvlUsd - The vault's total value locked in USD.
   * @param withdrawAmountUsd - The hypothetical withdrawal amount in USD.
   * @param minBufferPct - Minimum acceptable reserve ratio, 0-100 (default: 8, matching
   *   liquidityBufferService's "low" tier baseline).
   */
  public static previewReserveImpact(
    currentReserveUsd: number,
    vaultTvlUsd: number,
    withdrawAmountUsd: number,
    minBufferPct: number = 8,
  ): ReserveImpactPreview {
    const currentReserveRatioPct =
      vaultTvlUsd > 0 ? (currentReserveUsd / vaultTvlUsd) * 100 : 0;

    const projectedReserveUsd = Math.max(0, currentReserveUsd - withdrawAmountUsd);
    const projectedTvlUsd = Math.max(0, vaultTvlUsd - withdrawAmountUsd);
    const projectedReserveRatioPct =
      projectedTvlUsd > 0 ? (projectedReserveUsd / projectedTvlUsd) * 100 : 0;

    return {
      currentReserveRatioPct,
      projectedReserveRatioPct,
      projectedReserveUsd,
      breachesMinBuffer: projectedReserveRatioPct < minBufferPct,
      minBufferPct,
    };
  }
}
