import {
  assertWithinExportSizeLimit,
  ExportSizeLimitExceededError,
  exportService,
} from "../services/exportService";
import { type VaultPosition } from "../services/portfolioService";

describe("export response-size guardrails", () => {
  const positions: VaultPosition[] = [
    { protocol: "Blend", asset: "USDC", depositedUsd: 100, currentValueUsd: 110 },
    { protocol: "Soroswap", asset: "XLM", depositedUsd: 50, currentValueUsd: 55 },
  ];

  it("allows near-limit portfolio exports", async () => {
    const csv = await exportService.exportPortfolio(positions, {
      assetClass: "stablecoin,crypto",
      maxResponseBytes: 500,
    });

    expect(csv).toContain("Protocol,Asset,Deposited USD,Current Value USD,Asset Class");
  });

  it("fails early with a clear error when an export exceeds the response limit", async () => {
    await expect(
      exportService.exportPortfolio(positions, {
        assetClass: "stablecoin,crypto",
        maxResponseBytes: 10,
      }),
    ).rejects.toBeInstanceOf(ExportSizeLimitExceededError);
  });

  it("guards arbitrary analytics payloads", () => {
    expect(() => assertWithinExportSizeLimit("short", 10)).not.toThrow();
    expect(() => assertWithinExportSizeLimit("oversized", 3)).toThrow(
      "response-size limit",
    );
  });
});