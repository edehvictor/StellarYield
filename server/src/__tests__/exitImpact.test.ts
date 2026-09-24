import { ExitImpactService } from "../services/exitImpactService";

describe("ExitImpactService", () => {
  it("should calculate impact for a small withdrawal", () => {
    // 100 USD withdrawal from 1,000,000 liquidity
    const result = ExitImpactService.estimateImpact(100, 1_000_000, 50); // 50 bps fee
    
    expect(result.priceImpactPct).toBeCloseTo(0.01, 2); // 100 / 1,000,100 ≈ 0.01%
    expect(result.feeDragUsd).toBe(0.5); // 0.5% of 100
    expect(result.isLowLiquidity).toBe(false);
  });

  it("should warn for low liquidity / high impact", () => {
    // 50,000 USD withdrawal from 1,000,000 liquidity
    const result = ExitImpactService.estimateImpact(50_000, 1_000_000);
    
    expect(result.priceImpactPct).toBeCloseTo(4.76, 2); // 50k / 1.05M ≈ 4.76%
    expect(result.isLowLiquidity).toBe(true);
  });

  it("should provide optimistic and conservative ranges", () => {
    const result = ExitImpactService.estimateImpact(10_000, 1_000_000);

    expect(result.optimisticAmountUsd).toBeGreaterThan(result.estimatedReceivedUsd);
    expect(result.conservativeAmountUsd).toBeLessThan(result.estimatedReceivedUsd);
  });

  describe("previewReserveImpact", () => {
    it("computes the current and projected reserve ratios", () => {
      const result = ExitImpactService.previewReserveImpact(50_000, 500_000, 10_000);

      expect(result.currentReserveRatioPct).toBeCloseTo(10, 5);
      // reserve: 50k -> 40k, tvl: 500k -> 490k => 8.16%
      expect(result.projectedReserveRatioPct).toBeCloseTo(8.163, 2);
      expect(result.projectedReserveUsd).toBe(40_000);
    });

    it("defaults minBufferPct to 8 when not supplied", () => {
      const result = ExitImpactService.previewReserveImpact(50_000, 500_000, 1_000);
      expect(result.minBufferPct).toBe(8);
    });

    it("flags a breach when the projected ratio falls below minBufferPct", () => {
      const result = ExitImpactService.previewReserveImpact(100_000, 500_000, 90_000, 10);
      expect(result.breachesMinBuffer).toBe(true);
    });

    it("does not flag a breach when the projected ratio is at or above minBufferPct", () => {
      const result = ExitImpactService.previewReserveImpact(100_000, 500_000, 1_000, 10);
      expect(result.breachesMinBuffer).toBe(false);
    });

    it("never returns a negative projected reserve even when withdrawing more than the reserve", () => {
      const result = ExitImpactService.previewReserveImpact(1_000, 500_000, 5_000);
      expect(result.projectedReserveUsd).toBe(0);
    });

    it("returns a zero ratio when the projected TVL would be zero or negative", () => {
      const result = ExitImpactService.previewReserveImpact(10_000, 10_000, 10_000);
      expect(result.projectedReserveRatioPct).toBe(0);
    });

    it("returns a zero current ratio when vaultTvlUsd is zero", () => {
      const result = ExitImpactService.previewReserveImpact(0, 0, 100);
      expect(result.currentReserveRatioPct).toBe(0);
    });
  });
});
