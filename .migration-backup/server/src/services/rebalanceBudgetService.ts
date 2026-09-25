export interface RebalanceBudgetConfig {
  maxTransactionCostUsd: number;
  maxSlippagePct: number;
  minGainNetUsd: number;
  efficiencyThreshold: number; // expectedGain / totalCost
}

export const DEFAULT_REBALANCE_BUDGET: RebalanceBudgetConfig = {
  maxTransactionCostUsd: 5.0,
  maxSlippagePct: 0.5, // 0.5%
  minGainNetUsd: 10.0,
  efficiencyThreshold: 2.0, // Gain should be at least 2x the cost
};

export class RebalanceBudgetService {
  /**
   * Evaluates whether a rebalance operation should proceed based on costs and gains.
   * 
   * @param expectedGainUsd - The estimated gain from the rebalance in USD.
   * @param estimatedGasCostUsd - The estimated network transaction fee in USD.
   * @param estimatedSlippageCostUsd - The estimated slippage/price impact cost in USD.
   * @param config - Budget configuration.
   * @returns Execution decision.
   */
  public static validateRebalance(
    expectedGainUsd: number,
    estimatedGasCostUsd: number,
    estimatedSlippageCostUsd: number,
    config: RebalanceBudgetConfig = DEFAULT_REBALANCE_BUDGET
  ): { shouldExecute: boolean; reason?: string; netGain?: number } {
    const totalCostUsd = estimatedGasCostUsd + estimatedSlippageCostUsd;
    const netGainUsd = expectedGainUsd - totalCostUsd;

    // 1. Check absolute transaction cost
    if (estimatedGasCostUsd > config.maxTransactionCostUsd) {
      return {
        shouldExecute: false,
        reason: `Transaction cost ($${estimatedGasCostUsd}) exceeds budget ($${config.maxTransactionCostUsd})`,
        netGain: netGainUsd,
      };
    }

    // 2. Check net gain threshold
    if (netGainUsd < config.minGainNetUsd) {
      return {
        shouldExecute: false,
        reason: `Net gain ($${netGainUsd.toFixed(2)}) is below minimum threshold ($${config.minGainNetUsd})`,
        netGain: netGainUsd,
      };
    }

    // 3. Check efficiency (ROI)
    const efficiency = totalCostUsd > 0 ? expectedGainUsd / totalCostUsd : Infinity;
    if (efficiency < config.efficiencyThreshold) {
      return {
        shouldExecute: false,
        reason: `Rebalance efficiency (${efficiency.toFixed(2)}x) is below threshold (${config.efficiencyThreshold}x)`,
        netGain: netGainUsd,
      };
    }

    return {
      shouldExecute: true,
      netGain: netGainUsd,
    };
  }
}
