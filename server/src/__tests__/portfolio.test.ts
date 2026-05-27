import { PortfolioService, VaultPosition } from "../services/portfolioService";

describe("PortfolioService", () => {
  const mockPositions: VaultPosition[] = [
    { protocol: "Blend", asset: "USDC", depositedUsd: 1000, currentValueUsd: 1100 },
    { protocol: "Soroswap", asset: "XLM-USDC", depositedUsd: 2000, currentValueUsd: 2200 },
    { protocol: "Blend", asset: "XLM", depositedUsd: 500, currentValueUsd: 600 },
  ];

  it("should calculate exposure correctly", async () => {
    const result = await PortfolioService.getExposureMap(mockPositions);
    
    expect(result.totalValueUsd).toBe(3900);
    expect(result.byAsset["USDC"]).toBe(1100);
    expect(result.byAsset["XLM-USDC"]).toBe(2200);
    expect(result.byProtocol["Blend"]).toBe(1700);
    expect(result.byProtocol["Soroswap"]).toBe(2200);
  });

  it("should trigger concentration warnings", async () => {
    const concentratedPositions: VaultPosition[] = [
      { protocol: "Blend", asset: "USDC", depositedUsd: 1000, currentValueUsd: 8000 },
      { protocol: "Soroswap", asset: "XLM", depositedUsd: 1000, currentValueUsd: 2000 },
    ];
    const result = await PortfolioService.getExposureMap(concentratedPositions);
    
    expect(result.concentrationWarnings).toContain("High concentration in USDC (80%)");
    expect(result.concentrationWarnings).toContain("High concentration in Blend protocol (80%)");
  });

  it("should handle empty positions", async () => {
    const result = await PortfolioService.getExposureMap([]);
    expect(result.totalValueUsd).toBe(0);
    expect(result.concentrationWarnings).toHaveLength(0);
  });
});
