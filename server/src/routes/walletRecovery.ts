import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { sendError } from "../utils/errorResponse";
import {
  getSignatureRejectionSummary,
  recordSignatureRejection,
  SignatureRejectionValidationError,
} from "../services/walletSignatureRecoveryService";

const router = Router();

// Telemetry is cheap but unauthenticated; cap bursts per IP.
const rejectionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "TOO_MANY_REQUESTS", message: "Too many rejection reports." },
});

/**
 * POST /api/wallet/signature-rejections
 *
 * Record a declined/failed signature request and return stable recovery
 * guidance. The request may carry the client's classified `code` (preferred)
 * or a `reason` string, which is classified server-side and never echoed.
 *
 * Body: { action, walletAddress?, provider?, code?, reason?, attempt?, maxAttempts?,
 *         completedSteps?, totalSteps? }
 * 201 → WalletSignatureRejection + recordedAt
 * 400 → typed validation error
 */
router.post(
  "/signature-rejections",
  rejectionLimiter,
  (req: Request, res: Response): void => {
    try {
      const rejection = recordSignatureRejection(req.body ?? {});
      res.status(201).json(rejection);
    } catch (error) {
      if (error instanceof SignatureRejectionValidationError) {
        sendError(
          res,
          error.statusCode,
          error.code,
          error.message,
          { fieldErrors: error.details },
          undefined,
          false,
        );
        return;
      }

      sendError(
        res,
        500,
        "SIGNATURE_REJECTION_UNAVAILABLE",
        "The signature rejection could not be recorded. Please retry.",
        undefined,
        undefined,
        true,
      );
    }
  },
);

/**
 * GET /api/wallet/signature-rejections/summary?wallet=<address>
 *
 * Aggregate recorded rejections (optionally for one wallet). Returns an empty
 * summary with 200 when nothing has been recorded.
 */
router.get(
  "/signature-rejections/summary",
  (req: Request, res: Response): void => {
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet : undefined;
    if (wallet !== undefined && wallet.length > 128) {
      sendError(
        res,
        400,
        "INVALID_WALLET_ADDRESS",
        "wallet must be 128 characters or fewer.",
        { fieldErrors: [{ field: "wallet", code: "INVALID_WALLET_ADDRESS" }] },
        undefined,
        false,
      );
      return;
    }

    res.json(getSignatureRejectionSummary(wallet));
  },
);

export default router;
