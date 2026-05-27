export type DrawdownToleranceProfile = 'conservative' | 'balanced' | 'tolerant';

export interface DrawdownProfile {
  name: DrawdownToleranceProfile;
  penaltyMultiplier: number;
  maxAcceptableDrawdown: number;
}

export const DRAWDOWN_PROFILES: Record<DrawdownToleranceProfile, DrawdownProfile> = {
  conservative: {
    name: 'conservative',
    penaltyMultiplier: 2.0,
    maxAcceptableDrawdown: 5.0, // 5%
  },
  balanced: {
    name: 'balanced',
    penaltyMultiplier: 1.0,
    maxAcceptableDrawdown: 15.0, // 15%
  },
  tolerant: {
    name: 'tolerant',
    penaltyMultiplier: 0.5,
    maxAcceptableDrawdown: 35.0, // 35%
  },
};

export class DrawdownService {
  /**
   * Estimates drawdown characteristics based on historical volatility and depth.
   * If historical depth is insufficient, it degrades safely to a higher estimate.
   */
  estimateDrawdown(volatilityPct: number, historicalDepthDays: number): number {
    const baseDrawdown = volatilityPct * 1.5;
    
    // Safety degradation: if depth is low, increase drawdown estimate
    const safetyBuffer = historicalDepthDays < 30 ? 2.0 : historicalDepthDays < 90 ? 1.5 : 1.0;
    
    return baseDrawdown * safetyBuffer;
  }

  /**
   * Calculates a drawdown-aware yield multiplier [0, 1].
   */
  calculateYieldMultiplier(estimatedDrawdown: number, profileName: DrawdownToleranceProfile): number {
    const profile = DRAWDOWN_PROFILES[profileName];
    
    if (estimatedDrawdown > profile.maxAcceptableDrawdown) {
      // Extremely high drawdown relative to profile results in zero or near-zero multiplier
      return Math.max(0, 1 - (estimatedDrawdown / profile.maxAcceptableDrawdown) * 0.5);
    }
    
    const penalty = (estimatedDrawdown / 100) * profile.penaltyMultiplier;
    return Math.max(0.01, 1 - penalty);
  }
}

export const drawdownService = new DrawdownService();
