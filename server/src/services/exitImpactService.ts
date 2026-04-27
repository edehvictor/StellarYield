export interface ExitImpactEstimate {
  estimatedReceivedUsd: number;
  priceImpactPct: number;
  feeDragUsd: number;
  liquidityDepthUsd: number;
  isLowLiquidity: boolean;
  optimisticAmountUsd: number;
  conservativeAmountUsd: number;
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
}
