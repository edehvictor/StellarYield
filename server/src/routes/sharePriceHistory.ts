import { Router, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";

type SharePriceHistoryPrismaClient = {
  sharePriceSnapshot: {
    findMany(args: {
      where?: { vaultId?: string };
      orderBy: { snapshotAt: "asc" };
      take?: number;
    }): Promise<
      Array<{
        vaultId: string;
        sharePrice: number;
        totalShares: number;
        totalAssets: number;
        snapshotAt: Date;
      }>
    >;
  };
  $disconnect?: () => Promise<void>;
};

async function loadPrismaClient(): Promise<SharePriceHistoryPrismaClient | null> {
  try {
    const prismaModule = (await import("@prisma/client")) as unknown as {
      PrismaClient?: new () => SharePriceHistoryPrismaClient;
    };
    if (!prismaModule.PrismaClient) return null;
    return new prismaModule.PrismaClient();
  } catch {
    return null;
  }
}

/** Deterministic fixture used when no database is available. */
function generateFixtureSnapshots(
  vaultId: string,
  days = 90,
): Array<{ date: string; sharePrice: number; vaultId: string }> {
  const snapshots: Array<{ date: string; sharePrice: number; vaultId: string }> = [];
  let price = 1.0;
  const now = Date.now();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * 24 * 60 * 60 * 1000);
    // Deterministic drift: price increases ~0.01% per day with a small sine variation
    price = price * (1 + 0.0001 + 0.00005 * Math.sin(i * 0.3));
    snapshots.push({
      date: date.toISOString().split("T")[0],
      sharePrice: Math.round(price * 1_000_000) / 1_000_000,
      vaultId,
    });
  }

  return snapshots;
}

const sharePriceHistoryRouter = Router();

/**
 * GET /api/vaults/:vaultId/share-price-history
 *
 * Returns daily share price snapshots for the requested vault.
 * Falls back to a deterministic fixture when the database is unavailable.
 *
 * Query params:
 *   days  — number of trailing days to return (default: 90, max: 365)
 */
sharePriceHistoryRouter.get(
  "/:vaultId/share-price-history",
  async (req: Request, res: Response) => {
    const { vaultId } = req.params;

    const rawDays = Number(req.query.days ?? 90);
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 90;

    const prisma = await loadPrismaClient();

    if (!prisma || !(\"sharePriceSnapshot\" in prisma) || !prisma.sharePriceSnapshot) {
      const fixture = generateFixtureSnapshots(vaultId, days);
      res.json(fixture);
      return;
    }

    try {
      const rows = await prisma.sharePriceSnapshot.findMany({
        where: { vaultId },
        orderBy: { snapshotAt: "asc" },
        take: days,
      });

      await prisma.$disconnect?.();

      if (rows.length === 0) {
        res.json([]);
        return;
      }

      const result = rows.map((row) => ({
        date: row.snapshotAt.toISOString().split("T")[0],
        sharePrice: row.sharePrice,
        vaultId: row.vaultId,
      }));

      res.json(result);
    } catch (error) {
      await prisma.$disconnect?.().catch(() => undefined);
      sendError(res, 500, "SHARE_PRICE_HISTORY_ERROR", "Failed to retrieve share price history.");
      void error;
    }
  },
);

export default sharePriceHistoryRouter;
