import { Router, Request, Response } from "express";
import {
  calculatePnL,
  type UserTransaction,
  type SharePriceSnapshot,
} from "../services/pnl_engine";
import { sendError } from "../utils/errorResponse";
import { validateWalletAddress } from "../middleware/validation";

type PnLPrismaClient = {
  userTransaction: {
    findMany(args: {
      where: { walletAddress: string };
      orderBy: { timestamp: "asc" };
    }): Promise<
      Array<{
        action: string;
        amount: number;
        shares: number;
        sharePriceAtTx: number;
        timestamp: Date;
      }>
    >;
  };
  sharePriceSnapshot: {
    findMany(args: {
      where: { vaultId: string };
      orderBy: { snapshotAt: "asc" };
    }): Promise<Array<{ sharePrice: number; snapshotAt: Date }>>;
    findFirst(args: {
      where: { vaultId: string };
      orderBy: { snapshotAt: "desc" };
    }): Promise<{ sharePrice: number; snapshotAt: Date } | null>;
  };
  $disconnect?: () => Promise<void>;
};

async function loadPrismaClient(): Promise<PnLPrismaClient | null> {
  try {
    const prismaModule = (await import("@prisma/client")) as unknown as {
      PrismaClient?: new () => PnLPrismaClient;
    };
    if (!prismaModule.PrismaClient) return null;
    return new prismaModule.PrismaClient();
  } catch {
    return null;
  }
}

const pnlRouter = Router();

/**
 * GET /api/users/:address/pnl
 *
 * Returns the historical PnL for a user, including:
 * - Total deposited / withdrawn
 * - Current portfolio value
 * - Absolute PnL in USDC
 * - Time-Weighted Return percentage
 * - Daily PnL snapshots for charting
 */
pnlRouter.get("/:address/pnl", validateWalletAddress, async (req: Request, res: Response) => {
  const { address } = req.params;

  const prisma = await loadPrismaClient();

  if (!prisma) {
    sendError(res, 503, "DB_UNAVAILABLE", "PnL database is unavailable.");
    return;
  }

  try {
    // Fetch user transactions
    const rawTxs = await prisma.userTransaction.findMany({
      where: { walletAddress: address },
      orderBy: { timestamp: "asc" },
    });

    const transactions: UserTransaction[] = rawTxs.map((tx) => ({
      action: tx.action as "DEPOSIT" | "WITHDRAW",
      amount: tx.amount,
      shares: tx.shares,
      sharePriceAtTx: tx.sharePriceAtTx,
      timestamp: new Date(tx.timestamp),
    }));

    // Fetch share price history
    const rawPrices = await prisma.sharePriceSnapshot.findMany({
      where: { vaultId: "primary-yield-vault" },
      orderBy: { snapshotAt: "asc" },
    });

    const priceHistory: SharePriceSnapshot[] = rawPrices.map((p) => ({
      sharePrice: p.sharePrice,
      snapshotAt: new Date(p.snapshotAt),
    }));

    // Get current price (latest snapshot or fallback to 1.0)
    const latestSnapshot = await prisma.sharePriceSnapshot.findFirst({
      where: { vaultId: "primary-yield-vault" },
      orderBy: { snapshotAt: "desc" },
    });
    const currentPrice = latestSnapshot?.sharePrice ?? 1.0;

    await prisma.$disconnect?.();

    const pnl = calculatePnL(transactions, priceHistory, currentPrice);
    res.json(pnl);
  } catch (error) {
    console.error(`[pnl] Failed to calculate PnL for ${address}`, error);
    await prisma.$disconnect?.();
    sendError(res, 500, "PNL_CALCULATION_FAILED", "Failed to calculate PnL.");
  }
});

export default pnlRouter;
