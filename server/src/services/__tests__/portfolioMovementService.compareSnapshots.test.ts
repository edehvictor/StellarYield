import {
  PortfolioMovementService,
  SnapshotNotFoundError,
} from "../portfolioMovementService";

const walletAddress = "GTEST123";

/** Prisma double: compareSnapshotsByDate only ever reads dailyPortfolioSnapshot. */
function mockPrisma(
  snapshotsByDate: Record<string, { totalValueUsd: number; assetBreakdown: unknown }>,
) {
  return {
    dailyPortfolioSnapshot: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { walletAddress_snapshotDate: { walletAddress: string; snapshotDate: Date } };
        }) => {
          const key = where.walletAddress_snapshotDate.snapshotDate
            .toISOString()
            .split("T")[0];
          const found = snapshotsByDate[key];
          return found ? { ...found, walletAddress, snapshotDate: new Date(key) } : null;
        },
      ),
    },
  } as any;
}

describe("PortfolioMovementService.compareSnapshotsByDate", () => {
  it("returns a comparison for two snapshots that both exist", async () => {
    const prisma = mockPrisma({
      "2026-06-01": {
        totalValueUsd: 10000,
        assetBreakdown: { USDC: { valueUsd: 10000, quantity: 10000 } },
      },
      "2026-06-15": {
        totalValueUsd: 12000,
        assetBreakdown: { USDC: { valueUsd: 12000, quantity: 12000 } },
      },
    });
    const service = new PortfolioMovementService(prisma);

    const result = await service.compareSnapshotsByDate(
      walletAddress,
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-15T00:00:00.000Z"),
    );

    expect(result.fromTotalValueUsd).toBe(10000);
    expect(result.toTotalValueUsd).toBe(12000);
    expect(result.totalAbsoluteChange).toBe(2000);
  });

  it("throws a typed SnapshotNotFoundError when the 'from' snapshot is missing", async () => {
    const prisma = mockPrisma({
      "2026-06-15": {
        totalValueUsd: 12000,
        assetBreakdown: {},
      },
    });
    const service = new PortfolioMovementService(prisma);

    await expect(
      service.compareSnapshotsByDate(
        walletAddress,
        new Date("2026-06-01T00:00:00.000Z"),
        new Date("2026-06-15T00:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("throws a typed SnapshotNotFoundError when the 'to' snapshot is missing", async () => {
    const prisma = mockPrisma({
      "2026-06-01": {
        totalValueUsd: 10000,
        assetBreakdown: {},
      },
    });
    const service = new PortfolioMovementService(prisma);

    await expect(
      service.compareSnapshotsByDate(
        walletAddress,
        new Date("2026-06-01T00:00:00.000Z"),
        new Date("2026-06-15T00:00:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });
});
