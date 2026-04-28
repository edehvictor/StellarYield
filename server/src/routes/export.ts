import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  createCSVStream,
  createExportFilename,
  type TransactionRecord,
} from "../services/export";
import { sendError } from "../utils/errorResponse";
import { validateWalletAddress } from "../middleware/validation";

type ExportPrismaClient = {
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
        txHash: string;
        timestamp: Date;
      }>
    >;
    count(args: { where: { walletAddress: string } }): Promise<number>;
  };
  $disconnect?: () => Promise<void>;
};

async function loadPrismaClient(): Promise<ExportPrismaClient | null> {
  try {
    const prismaModule = (await import("@prisma/client")) as unknown as {
      PrismaClient?: new () => ExportPrismaClient;
    };
    if (!prismaModule.PrismaClient) return null;
    return new prismaModule.PrismaClient();
  } catch {
    return null;
  }
}

const exportRouter = Router();

/**
 * Rate limit: max 5 export requests per 15 minutes per IP.
 *
 * Prevents database exhaustion attacks from repeated large queries.
 */
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many export requests. Please try again later.",
});

/**
 * GET /api/users/:address/export
 *
 * Fetches all historical vault events for a user, transforms them
 * into a standardized CSV, and streams it back as a download.
 *
 * Uses streaming to handle users with thousands of transactions.
 */
exportRouter.get(
  "/:address/export",
  exportLimiter,
  validateWalletAddress,
  async (req: Request, res: Response) => {
    const { address } = req.params;

    const prisma = await loadPrismaClient();

    if (!prisma) {
      sendError(res, 503, "DB_UNAVAILABLE", "Export database is unavailable.");
      return;
    }

    try {
      // Check transaction count first
      const count = await prisma.userTransaction.count({
        where: { walletAddress: address },
      });

      if (count === 0) {
        await prisma.$disconnect?.();
        sendError(res, 404, "NO_TRANSACTIONS", "No transactions found for this address.");
        return;
      }

      // Fetch all transactions for the user
      const rawTxs = await prisma.userTransaction.findMany({
        where: { walletAddress: address },
        orderBy: { timestamp: "asc" },
      });

      await prisma.$disconnect?.();

      // Transform to standardized CSV records
      const records: TransactionRecord[] = rawTxs.map((tx) => ({
        date: new Date(tx.timestamp).toISOString(),
        action: tx.action,
        asset: "USDC",
        amount: tx.amount,
        usdValue: tx.amount * tx.sharePriceAtTx,
        txHash: tx.txHash,
      }));

      // Set response headers for CSV download
      const filename = createExportFilename(address);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      // Stream the CSV to avoid memory issues with large datasets
      const csvStream = createCSVStream(records);
      csvStream.pipe(res);
    } catch (error) {
      console.error(`[export] Failed to export data for ${address}`, error);
      sendError(res, 500, "EXPORT_FAILED", "Failed to generate export.");
    }
  },
);

export default exportRouter;
