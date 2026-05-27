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
});
