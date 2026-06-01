import { RiskPreferenceDriftService, type UserRiskProfile, type PortfolioBehavior } from '../services/riskPreferenceDriftService';

describe('RiskPreferenceDriftService', () => {
  let service: RiskPreferenceDriftService;

  const conservativeProfile: UserRiskProfile = {
    userId: 'user-1',
    statedPreference: 'conservative',
    maxConcentrationPct: 25,
    maxVolatilityPct: 8,
    minLiquidityUsd: 500_000,
  };

  const balancedProfile: UserRiskProfile = {
    userId: 'user-2',
    statedPreference: 'balanced',
    maxConcentrationPct: 40,
    maxVolatilityPct: 18,
    minLiquidityUsd: 200_000,
  };

  const aggressiveProfile: UserRiskProfile = {
    userId: 'user-3',
    statedPreference: 'aggressive',
    maxConcentrationPct: 60,
    maxVolatilityPct: 35,
    minLiquidityUsd: 50_000,
  };

  beforeEach(() => {
    service = new RiskPreferenceDriftService();
  });

  describe('conservative drift cases', () => {
    it('should not detect drift when conservative portfolio is within bounds', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 20,
        currentVolatilityPct: 5,
        currentLiquidityUsd: 1_000_000,
        positions: [
          { protocol: 'Blend', weightPct: 20, volatilityPct: 5, liquidityUsd: 1_000_000 },
          { protocol: 'DeFindex', weightPct: 20, volatilityPct: 3, liquidityUsd: 2_000_000 },
          { protocol: 'Soroswap', weightPct: 20, volatilityPct: 6, liquidityUsd: 800_000 },
          { protocol: 'Aquarius', weightPct: 20, volatilityPct: 4, liquidityUsd: 1_500_000 },
          { protocol: 'Blend-2', weightPct: 20, volatilityPct: 5, liquidityUsd: 1_200_000 },
        ],
      };

      const result = service.detectDrift(conservativeProfile, behavior);

      expect(result.isDrifting).toBe(false);
      expect(result.overallDriftPct).toBe(0);
      expect(result.message).toContain('aligns');
    });

    it('should detect concentration drift for conservative', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 50,
        currentVolatilityPct: 5,
        currentLiquidityUsd: 1_000_000,
        positions: [
          { protocol: 'Soroswap', weightPct: 50, volatilityPct: 12, liquidityUsd: 500_000 },
          { protocol: 'Blend', weightPct: 50, volatilityPct: 5, liquidityUsd: 1_000_000 },
        ],
      };

      const result = service.detectDrift(conservativeProfile, behavior);

      expect(result.isDrifting).toBe(true);
      expect(result.dimensions.some(d => d.dimension === 'concentration' && d.isDrifting)).toBe(true);
    });

    it('should detect volatility drift for conservative', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 20,
        currentVolatilityPct: 15,
        currentLiquidityUsd: 1_000_000,
        positions: [
          { protocol: 'Soroswap', weightPct: 50, volatilityPct: 20, liquidityUsd: 500_000 },
          { protocol: 'Blend', weightPct: 50, volatilityPct: 10, liquidityUsd: 1_000_000 },
        ],
      };

      const result = service.detectDrift(conservativeProfile, behavior);

      expect(result.isDrifting).toBe(true);
      expect(result.dimensions.some(d => d.dimension === 'volatility' && d.isDrifting)).toBe(true);
    });

    it('should detect liquidity drift for conservative', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 20,
        currentVolatilityPct: 5,
        currentLiquidityUsd: 50_000,
        positions: [
          { protocol: 'Soroswap', weightPct: 100, volatilityPct: 5, liquidityUsd: 50_000 },
        ],
      };

      const result = service.detectDrift(conservativeProfile, behavior);

      expect(result.isDrifting).toBe(true);
      expect(result.dimensions.some(d => d.dimension === 'liquidity' && d.isDrifting)).toBe(true);
    });
  });

  describe('balanced drift cases', () => {
    it('should not detect drift when balanced portfolio is within bounds', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 35,
        currentVolatilityPct: 12,
        currentLiquidityUsd: 500_000,
        positions: [
          { protocol: 'Blend', weightPct: 35, volatilityPct: 8, liquidityUsd: 500_000 },
          { protocol: 'Soroswap', weightPct: 35, volatilityPct: 15, liquidityUsd: 300_000 },
          { protocol: 'DeFindex', weightPct: 30, volatilityPct: 10, liquidityUsd: 400_000 },
        ],
      };

      const result = service.detectDrift(balancedProfile, behavior);

      expect(result.isDrifting).toBe(false);
      expect(result.overallDriftPct).toBe(0);
    });

    it('should detect concentration drift for balanced', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 70,
        currentVolatilityPct: 12,
        currentLiquidityUsd: 500_000,
        positions: [
          { protocol: 'Soroswap', weightPct: 70, volatilityPct: 15, liquidityUsd: 300_000 },
          { protocol: 'Blend', weightPct: 30, volatilityPct: 5, liquidityUsd: 1_000_000 },
        ],
      };

      const result = service.detectDrift(balancedProfile, behavior);

      expect(result.isDrifting).toBe(true);
      expect(result.dimensions.some(d => d.dimension === 'concentration' && d.isDrifting)).toBe(true);
    });
  });

  describe('aggressive drift cases', () => {
    it('should not detect drift when aggressive portfolio is within bounds', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 55,
        currentVolatilityPct: 30,
        currentLiquidityUsd: 100_000,
        positions: [
          { protocol: 'Soroswap', weightPct: 55, volatilityPct: 32, liquidityUsd: 100_000 },
          { protocol: 'Aquarius', weightPct: 45, volatilityPct: 28, liquidityUsd: 80_000 },
        ],
      };

      const result = service.detectDrift(aggressiveProfile, behavior);

      expect(result.isDrifting).toBe(false);
      expect(result.overallDriftPct).toBe(0);
    });

    it('should detect volatility drift for aggressive', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 50,
        currentVolatilityPct: 45,
        currentLiquidityUsd: 100_000,
        positions: [
          { protocol: 'Soroswap', weightPct: 50, volatilityPct: 50, liquidityUsd: 100_000 },
          { protocol: 'Aquarius', weightPct: 50, volatilityPct: 40, liquidityUsd: 80_000 },
        ],
      };

      const result = service.detectDrift(aggressiveProfile, behavior);

      expect(result.isDrifting).toBe(true);
      expect(result.dimensions.some(d => d.dimension === 'volatility' && d.isDrifting)).toBe(true);
    });

    it('should provide correct message for drifting portfolios', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 80,
        currentVolatilityPct: 40,
        currentLiquidityUsd: 10_000,
        positions: [
          { protocol: 'Soroswap', weightPct: 80, volatilityPct: 40, liquidityUsd: 10_000 },
        ],
      };

      const result = service.detectDrift(aggressiveProfile, behavior);

      expect(result.isDrifting).toBe(true);
      expect(result.message).toContain('Detected drift');
      expect(result.message).toContain('aggressive');
      expect(result.dimensions.filter(d => d.isDrifting).length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty positions', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 0,
        currentVolatilityPct: 0,
        currentLiquidityUsd: 0,
        positions: [],
      };

      const result = service.detectDrift(conservativeProfile, behavior);

      expect(result.isDrifting).toBe(false);
      expect(result.overallDriftPct).toBe(0);
    });

    it('should return correct thresholds for each preference', () => {
      const conservativeThresholds = service.getThresholdsForPreference('conservative');
      expect(conservativeThresholds.maxConcentrationPct).toBe(25);
      expect(conservativeThresholds.maxVolatilityPct).toBe(8);
      expect(conservativeThresholds.minLiquidityUsd).toBe(500_000);

      const balancedThresholds = service.getThresholdsForPreference('balanced');
      expect(balancedThresholds.maxConcentrationPct).toBe(40);

      const aggressiveThresholds = service.getThresholdsForPreference('aggressive');
      expect(aggressiveThresholds.maxConcentrationPct).toBe(60);
    });

    it('should compute overallDriftPct correctly', () => {
      const behavior: PortfolioBehavior = {
        currentConcentrationPct: 50,
        currentVolatilityPct: 25,
        currentLiquidityUsd: 10_000,
        positions: [
          { protocol: 'Soroswap', weightPct: 50, volatilityPct: 25, liquidityUsd: 10_000 },
          { protocol: 'Blend', weightPct: 50, volatilityPct: 5, liquidityUsd: 1_000_000 },
        ],
      };

      const result = service.detectDrift(conservativeProfile, behavior);

      expect(result.overallDriftPct).toBeGreaterThan(0);
      expect(result.overallDriftPct).toBeLessThanOrEqual(100);
    });
  });
});
