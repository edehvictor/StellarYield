import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  buildTaxLotPreview,
  createCSVStream,
  createExportFilename,
  previewToCsvRecords,
  type RawTaxTransaction,
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

async function fetchRawTransactions(
  address: string,
): Promise<{
  status: "ok";
  rawTxs: RawTaxTransaction[];
} | {
  status: "error";
  httpCode: number;
  errorCode: string;
  message: string;
}> {
  const prisma = await loadPrismaClient();
  if (!prisma) {
    return {
      status: "error",
      httpCode: 503,
      errorCode: "DB_UNAVAILABLE",
      message: "Export database is unavailable.",
    };
  }

  try {
    const count = await prisma.userTransaction.count({
      where: { walletAddress: address },
    });
    if (count === 0) {
      await prisma.$disconnect?.();
      return {
        status: "error",
        httpCode: 404,
        errorCode: "NO_TRANSACTIONS",
        message: "No transactions found for this address.",
      };
    }

    const rawTxs = await prisma.userTransaction.findMany({
      where: { walletAddress: address },
      orderBy: { timestamp: "asc" },
    });
    await prisma.$disconnect?.();
    return { status: "ok", rawTxs };
  } catch (error) {
    await prisma.$disconnect?.();
    throw error;
  }
}

/**
 * GET /api/users/:address/export/preview
 *
 * Returns a JSON preview of the user's tax lots: cost basis, realized
 * yield, per-row and global warnings, and a `canDownload` flag. The
 * client renders this as a table before allowing the CSV download so
 * users can verify the export and so missing-basis / missing-timestamp /
 * unsupported-token cases surface up-front.
 */
exportRouter.get(
  "/:address/export/preview",
  exportLimiter,
  validateWalletAddress,
  async (req: Request, res: Response) => {
    const { address } = req.params;
    try {
      const fetched = await fetchRawTransactions(address);
      if (fetched.status === "error") {
        sendError(res, fetched.httpCode, fetched.errorCode, fetched.message);
        return;
      }
      const preview = buildTaxLotPreview(fetched.rawTxs);
      res.json(preview);
    } catch (error) {
      console.error(
        "[export] Failed to build tax preview for address: %s",
        encodeURIComponent(address),
        error,
      );
      sendError(
        res,
        500,
        "EXPORT_PREVIEW_FAILED",
        "Failed to build tax export preview.",
      );
    }
  },
);

/**
 * GET /api/users/:address/export
 *
 * Fetches all historical vault events for a user, transforms them
 * into a standardized CSV, and streams it back as a download. The
 * route refuses to stream when the tax-lot preview would surface
 * blocking warnings (missing basis / missing timestamp / unsupported
 * token) so users do not receive a silently incomplete CSV.
 *
 * Uses streaming to handle users with thousands of transactions.
 */
exportRouter.get(
  "/:address/export",
  exportLimiter,
  validateWalletAddress,
  async (req: Request, res: Response) => {
    const { address } = req.params;

    try {
      const fetched = await fetchRawTransactions(address);
      if (fetched.status === "error") {
        sendError(res, fetched.httpCode, fetched.errorCode, fetched.message);
        return;
      }

      const preview = buildTaxLotPreview(fetched.rawTxs);
      if (!preview.canDownload) {
        sendError(
          res,
          409,
          "PREVIEW_WARNINGS_PRESENT",
          "Tax export has blocking warnings; resolve them via the preview endpoint before downloading.",
        );
        return;
      }

      const records = previewToCsvRecords(preview);

      const filename = createExportFilename(address);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      const csvStream = createCSVStream(records);
      csvStream.pipe(res);
    } catch (error) {
      console.error("[export] Failed to export data for address: %s", encodeURIComponent(address), error);
      sendError(res, 500, "EXPORT_FAILED", "Failed to generate export.");
    }
  },
);

export default exportRouter;
