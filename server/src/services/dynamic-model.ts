import { BigNumber } from 'bignumber.js';

export class PriceImpactTooHighError extends Error {
  constructor(public impact: number) {
    super(`Price impact of ${impact.toFixed(2)}% exceeds the maximum allowed threshold of 15%.`);
    this.name = 'PriceImpactTooHighError';
  }
}

export interface ImpactPriceResult {
  executionPrice: BigNumber;
  priceImpact: number;
  feeIncurred: BigNumber;
}

/**
 * Pricing Service for ShadeProtocol
 * Implements Constant Product Formula (x * y = k) with risk safeguards.
 */
export class PricingService {
  private readonly IMPACT_LIMIT = 15;

  /**
   * Calculates execution price and impact for a trade.
   * 
   * @param baseAmount - The amount of asset X being swapped in
   * @param poolLiquidityX - Total inventory of asset X in the pool
   * @param poolLiquidityY - Total inventory of asset Y in the pool
   * @param feeBasisPoints - Protocol fee in basis points (e.g., 30 for 0.3%)
   */
  public calculateImpactPrice(
    baseAmount: BigNumber,
    poolLiquidityX: BigNumber,
    poolLiquidityY: BigNumber,
    feeBasisPoints: number
  ): ImpactPriceResult {
    // 1. Calculate Fee
    const feeIncurred = baseAmount.times(feeBasisPoints).dividedBy(10000);
    const effectiveInput = baseAmount.minus(feeIncurred);

    // 2. Constant Product Formula: (x + Δx)(y - Δy) = k
    // Δy = (y * Δx) / (x + Δx)
    const amountOut = poolLiquidityY.times(effectiveInput).dividedBy(
      poolLiquidityX.plus(effectiveInput)
    );

    // 3. Price Calculations
    const spotPrice = poolLiquidityY.dividedBy(poolLiquidityX);
    const executionPrice = amountOut.dividedBy(baseAmount);

    // 4. Price Impact: (SpotPrice - ExecutionPrice) / SpotPrice
    const priceImpact = spotPrice.minus(executionPrice)
      .dividedBy(spotPrice)
      .times(100)
      .toNumber();

    // 5. Circuit Breaker
    if (priceImpact > this.IMPACT_LIMIT) {
      throw new PriceImpactTooHighError(priceImpact);
    }

    return { executionPrice, priceImpact, feeIncurred };
  }
}

export const pricingService = new PricingService();