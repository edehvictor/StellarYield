import { compareSnapshots, type SnapshotComparisonInput } from "../../../shared/types/snapshotComparison";

const walletAddress = "GTEST123";

function snapshot(
  overrides: Partial<SnapshotComparisonInput> = {},
): SnapshotComparisonInput {
  return {
    walletAddress,
    snapshotDate: "2026-06-01",
    totalValueUsd: 10000,
    assetBreakdown: {
      USDC: { valueUsd: 5000, quantity: 5000 },
      XLM: { valueUsd: 5000, quantity: 2500 },
    },
    ...overrides,
  };
}

describe("compareSnapshots", () => {
  it("reports per-asset and total value changes between two snapshots", () => {
    const from = snapshot({
      snapshotDate: "2026-06-01",
      totalValueUsd: 10000,
      assetBreakdown: {
        USDC: { valueUsd: 5000, quantity: 5000 },
        XLM: { valueUsd: 5000, quantity: 2500 },
      },
    });
    const to = snapshot({
      snapshotDate: "2026-06-15",
      totalValueUsd: 14000,
      assetBreakdown: {
        USDC: { valueUsd: 6000, quantity: 6000 },
        XLM: { valueUsd: 8000, quantity: 4000 },
      },
    });

    const result = compareSnapshots(from, to);

    expect(result.fromSnapshotDate).toBe("2026-06-01");
    expect(result.toSnapshotDate).toBe("2026-06-15");
    expect(result.totalAbsoluteChange).toBe(4000);
    expect(result.totalPercentChange).toBe(40);

    const usdc = result.assets.find((a) => a.asset === "USDC");
    expect(usdc).toMatchObject({
      status: "changed",
      fromValueUsd: 5000,
      toValueUsd: 6000,
      absoluteChange: 1000,
      percentChange: 20,
    });

    const xlm = result.assets.find((a) => a.asset === "XLM");
    expect(xlm).toMatchObject({
      status: "changed",
      fromValueUsd: 5000,
      toValueUsd: 8000,
      absoluteChange: 3000,
    });

    expect(result.addedAssets).toEqual([]);
    expect(result.removedAssets).toEqual([]);
  });

  it("reports no changes for identical snapshots", () => {
    const from = snapshot();
    const to = snapshot({ snapshotDate: "2026-06-02" });

    const result = compareSnapshots(from, to);

    expect(result.totalAbsoluteChange).toBe(0);
    expect(result.totalPercentChange).toBe(0);
    expect(result.addedAssets).toEqual([]);
    expect(result.removedAssets).toEqual([]);
    for (const asset of result.assets) {
      expect(asset.status).toBe("unchanged");
      expect(asset.absoluteChange).toBe(0);
    }
  });

  it("flags an asset that exists only in the 'to' snapshot as added", () => {
    const from = snapshot({
      assetBreakdown: { USDC: { valueUsd: 5000, quantity: 5000 } },
      totalValueUsd: 5000,
    });
    const to = snapshot({
      snapshotDate: "2026-06-10",
      assetBreakdown: {
        USDC: { valueUsd: 5000, quantity: 5000 },
        AQUA: { valueUsd: 1200, quantity: 3000 },
      },
      totalValueUsd: 6200,
    });

    const result = compareSnapshots(from, to);

    expect(result.addedAssets).toEqual(["AQUA"]);
    expect(result.removedAssets).toEqual([]);

    const aqua = result.assets.find((a) => a.asset === "AQUA");
    expect(aqua).toMatchObject({
      status: "added",
      fromValueUsd: 0,
      toValueUsd: 1200,
      percentChange: null,
    });
  });

  it("flags an asset that exists only in the 'from' snapshot as removed", () => {
    const from = snapshot({
      assetBreakdown: {
        USDC: { valueUsd: 5000, quantity: 5000 },
        AQUA: { valueUsd: 1200, quantity: 3000 },
      },
      totalValueUsd: 6200,
    });
    const to = snapshot({
      snapshotDate: "2026-06-10",
      assetBreakdown: { USDC: { valueUsd: 5000, quantity: 5000 } },
      totalValueUsd: 5000,
    });

    const result = compareSnapshots(from, to);

    expect(result.removedAssets).toEqual(["AQUA"]);
    expect(result.addedAssets).toEqual([]);

    const aqua = result.assets.find((a) => a.asset === "AQUA");
    expect(aqua).toMatchObject({
      status: "removed",
      fromValueUsd: 1200,
      toValueUsd: 0,
      absoluteChange: -1200,
    });
  });

  it("handles a from-total of zero without dividing by zero", () => {
    const from = snapshot({ totalValueUsd: 0, assetBreakdown: {} });
    const to = snapshot({
      snapshotDate: "2026-06-05",
      totalValueUsd: 500,
      assetBreakdown: { USDC: { valueUsd: 500, quantity: 500 } },
    });

    const result = compareSnapshots(from, to);

    expect(result.totalPercentChange).toBeNull();
    expect(result.totalAbsoluteChange).toBe(500);
    expect(result.addedAssets).toEqual(["USDC"]);
  });

  it("sorts assets by magnitude of change, largest first", () => {
    const from = snapshot({
      assetBreakdown: {
        USDC: { valueUsd: 1000, quantity: 1000 },
        XLM: { valueUsd: 1000, quantity: 500 },
      },
      totalValueUsd: 2000,
    });
    const to = snapshot({
      snapshotDate: "2026-06-05",
      assetBreakdown: {
        USDC: { valueUsd: 1050, quantity: 1050 },
        XLM: { valueUsd: 3000, quantity: 1500 },
      },
      totalValueUsd: 4050,
    });

    const result = compareSnapshots(from, to);
    expect(result.assets[0].asset).toBe("XLM");
    expect(result.assets[1].asset).toBe("USDC");
  });
});
