import { PROTOCOLS } from "../config/protocols";
import { slippageRegistry } from "./slippageRegistry";

export interface LiquidityHealthScore {
  strategyId: string;
  score: number; // 0-100
  status: 'healthy' | 'warning' | 'critical';
  components: {
    depth: number;
    spread: number;
    stability: number;
    withdrawalSensitivity: number;
  };
  thresholds: {
    warning: number;
    critical: number;
  };
  updatedAt: string;
}

export class LiquidityHealthService {
  private readonly WARNING_THRESHOLD = 60;
  private readonly CRITICAL_THRESHOLD = 30;

  /**
   * Calculates a composite liquidity health score for a strategy.
   * 
   * @param strategyId The ID of the strategy (protocol name lowercase)
   */
  async calculateScore(strategyId: string): Promise<LiquidityHealthScore> {
    const protocol = PROTOCOLS.find(p => p.protocolName.toLowerCase() === strategyId);
    if (!protocol) {
      throw new Error(`Protocol ${strategyId} not found`);
    }

    // 1. Depth Score (based on TVL)
    // Target TVL for "perfect" depth is $10M
    const depth = Math.min(1, protocol.baseTvlUsd / 10_000_000);

    // 2. Spread Score (based on slippage)
    // Calculate slippage for a $10,000 withdrawal
    const model = slippageRegistry.getModel(protocol.protocolName);
    const slippage = model.calculateSlippage(BigInt(10_000), BigInt(protocol.baseTvlUsd));
    // 0.1% slippage = 1.0 score, 2% slippage = 0 score
    const spread = Math.max(0, 1 - (slippage / 0.02));

    // 3. Stability Score (based on volatility)
    // 0% volatility = 1.0 score, 10% volatility = 0 score
    const stability = Math.max(0, 1 - (protocol.volatilityPct / 10));

    // 4. Withdrawal Sensitivity (based on protocol age and type)
    // Older protocols are assumed more stable against withdrawals
    const ageFactor = Math.min(1, protocol.protocolAgeDays / 365);
    // Withdrawal velocity if available, else derived
    const withdrawalSensitivity = ageFactor; 

    // Composite Weighted Score
    const compositeScore = (
      (depth * 0.35) + 
      (spread * 0.35) + 
      (stability * 0.15) + 
      (withdrawalSensitivity * 0.15)
    ) * 100;

    const roundedScore = Math.round(compositeScore);
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (roundedScore < this.CRITICAL_THRESHOLD) status = 'critical';
    else if (roundedScore < this.WARNING_THRESHOLD) status = 'warning';

    return {
      strategyId,
      score: roundedScore,
      status,
      components: {
        depth: Math.round(depth * 100),
        spread: Math.round(spread * 100),
        stability: Math.round(stability * 100),
        withdrawalSensitivity: Math.round(withdrawalSensitivity * 100),
      },
      thresholds: {
        warning: this.WARNING_THRESHOLD,
        critical: this.CRITICAL_THRESHOLD,
      },
      updatedAt: new Date().toISOString(),
    };
  }

  async getAllScores(): Promise<LiquidityHealthScore[]> {
    const promises = PROTOCOLS.map(p => this.calculateScore(p.protocolName.toLowerCase()));
    return Promise.all(promises);
  }

  /**
   * Returns true if liquidity health is insufficient for safe execution.
   */
  async isSuppressed(strategyId: string): Promise<boolean> {
    const result = await this.calculateScore(strategyId);
    return result.score < this.CRITICAL_THRESHOLD;
  }
}

export const liquidityHealthService = new LiquidityHealthService();
