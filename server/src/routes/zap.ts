import { Router, Request, Response } from "express";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";
import {
  getZapQuote,
  verifyZapQuote,
  RECOVERABLE_VERIFY_ERROR_CODES,
  type ZapQuoteBody,
} from "../services/zapQuote";
import { sendError } from "../utils/errorResponse";
import { validateZapQuote } from "../middleware/validation";
import { recordFailure, resolveNetworkLabel } from "../monitoring/prometheus";
import { getVaultPauseState } from "../services/vaultPauseStateService";
import { computeQuoteAssumptionFingerprint } from "../../../shared/types/quoteAssumptionFingerprint";
import {
  buildQuoteVerificationDiagnostics,
  buildTransactionReviewFailureDiagnostics,
} from "../../../shared/types/transactionReviewDiagnostic";
import {
  ReviewOperationError,
  isValidReviewOperationId,
  parseReviewOperationEvent,
  parseReviewOperationRequest,
} from "../../../shared/types/transactionReviewOperation";
import {
  ReviewOperationInFlightError,
  ReviewOperationNotFoundError,
  beginOrResumeReviewOperation,
  getReviewOperation,
  recordReviewOperationEvent,
} from "../services/transactionReviewOperationService";

const router = Router();

router.get("/pause-state", async (_req: Request, res: Response) => {
  res.json({ vaultPauseState: await getVaultPauseState() });
});

router.get("/supported-assets", (_req: Request, res: Response) => {
  try {
    res.json(getZapSupportedAssetsPayload());
  } catch (error) {
    sendError(
      res,
      503,
      "CONFIG_UNAVAILABLE",
      "Supported assets configuration is unavailable.",
      error instanceof Error ? error.message : undefined
    );
  }
});

router.post("/quote", validateZapQuote, async (req: Request, res: Response) => {
  try {
    const b = req.body as ZapQuoteBody;

    const body: ZapQuoteBody = {
      inputTokenContract: String(b.inputTokenContract),
      vaultTokenContract: String(b.vaultTokenContract),
      amountInStroops: String(b.amountInStroops),
      inputDecimals: Number(b.inputDecimals ?? 7),
      vaultDecimals: Number(b.vaultDecimals ?? 7),
      slippageTolerance: b.slippageTolerance !== undefined ? Number(b.slippageTolerance) : undefined,
      // Reserve check (#1148) is opt-in: only run when the caller supplies a
      // wallet address to check against.
      walletAddress:
        typeof b.walletAddress === "string" && b.walletAddress.trim() !== ""
          ? b.walletAddress.trim()
          : undefined,
    };

    const [quote, vaultPauseState] = await Promise.all([
      getZapQuote(body),
      getVaultPauseState(),
    ]);
    res.json({
      path: quote.path,
      expectedAmountOutStroops: quote.expectedAmountOutStroops,
      source: quote.source,
      slippageApplied: quote.slippageApplied,
      amountOutAfterSlippage: quote.amountOutAfterSlippage,
      quotedAt: quote.quotedAt,
      minAmountOutStroops: quote.minAmountOutStroops,
      quoteAgeMs: quote.quoteAgeMs,
      isFallback: quote.isFallback,
      issuedAt: quote.issuedAt,
      expiresAt: quote.expiresAt,
      routeHash: quote.routeHash,
      assetConfigVersion: quote.assetConfigVersion,
      vaultPauseState,
      assumptionFingerprint: quote.assumptionFingerprint,
      assumptions: quote.assumptions,
      routeAssumptions: quote.routeAssumptions,
      ...(quote.reserveCheck ? { reserveCheck: quote.reserveCheck } : {}),
    });
  } catch (e) {
    recordFailure({
      route: "zap/quote",
      network: resolveNetworkLabel(),
      failure_category: "quote_failed",
    });
    sendError(
      res,
      500,
      "QUOTE_FAILED",
      "Quote failed",
      // Raw exception text can carry RPC URLs or addresses; callers get a
      // privacy-safe stage diagnostic instead (#1893).
      undefined,
      undefined,
      true,
      buildTransactionReviewFailureDiagnostics("STAGE_UNAVAILABLE", { stage: "quote" })
    );
  }
});

router.post("/verify", (req: Request, res: Response) => {
  try {
    const result = verifyZapQuote(req.body);
    if (!result.valid) {
      return sendError(
        res,
        400,
        result.errorCode,
        result.reason,
        undefined,
        undefined,
        RECOVERABLE_VERIFY_ERROR_CODES.has(result.errorCode) || undefined,
        buildQuoteVerificationDiagnostics(result.errorCode),
      );
    }
    res.json({ success: true });
  } catch (e) {
    sendError(
      res,
      500,
      "VERIFY_FAILED",
      "Failed to verify quote",
      undefined,
      undefined,
      undefined,
      buildTransactionReviewFailureDiagnostics("STAGE_UNAVAILABLE", { stage: "quote-verification" })
    );
  }
});

router.post("/fingerprint", (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object") {
      return sendError(
        res,
        400,
        "INVALID_ASSUMPTIONS",
        "Invalid assumptions payload",
        undefined,
        undefined,
        undefined,
        buildTransactionReviewFailureDiagnostics("VALIDATION_FAILED", { stage: "request-validation" })
      );
    }
    const result = computeQuoteAssumptionFingerprint(body);
    res.json(result);
  } catch (e) {
    sendError(
      res,
      500,
      "FINGERPRINT_FAILED",
      "Failed to compute quote assumption fingerprint",
      undefined,
      undefined,
      undefined,
      buildTransactionReviewFailureDiagnostics("STAGE_UNAVAILABLE", { stage: "quote-verification" })
    );
  }
});

// ── Review operation journal (#1891) ─────────────────────────────────────
//
// Records a reviewed deposit's progress so an interrupted flow can resume
// and a second deposit is refused while a signed one could still land.

function sendReviewOperationError(res: Response, error: unknown): boolean {
  if (error instanceof ReviewOperationInFlightError) {
    sendError(res, 409, error.code, error.message, { operation: error.inFlight }, undefined, true);
    return true;
  }
  if (error instanceof ReviewOperationNotFoundError) {
    sendError(res, 404, error.code, error.message);
    return true;
  }
  if (error instanceof ReviewOperationError) {
    const status = error.code === "INVALID_REVIEW_OPERATION" ? 400 : 409;
    sendError(res, status, error.code, error.message);
    return true;
  }
  return false;
}

function readOperationId(raw: unknown): string | null {
  return isValidReviewOperationId(raw) ? raw : null;
}

function readWallet(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * POST /api/zap/review-operations
 * Body: { operationId, walletAddress, routeHash, amountInStroops,
 *         minAmountOutStroops, deadlineUnixSeconds }
 * 201 when started, 200 when the same operation is resumed.
 */
router.post("/review-operations", (req: Request, res: Response) => {
  try {
    const operationId = readOperationId((req.body as { operationId?: unknown } | undefined)?.operationId);
    if (!operationId) {
      return sendError(res, 400, "INVALID_REVIEW_OPERATION", "operationId is required (8-128 safe characters).");
    }
    const request = parseReviewOperationRequest(req.body);
    const { operation, resumed } = beginOrResumeReviewOperation(operationId, request);
    res.status(resumed ? 200 : 201).json({ operation, resumed });
  } catch (error) {
    if (sendReviewOperationError(res, error)) return;
    sendError(res, 500, "REVIEW_OPERATION_FAILED", "Failed to record review operation", undefined, undefined, true);
  }
});

/**
 * POST /api/zap/review-operations/:operationId/events
 * Body: { walletAddress, type: "signed"|"submitted"|"confirmed"|"failed", txHash?, code? }
 */
router.post("/review-operations/:operationId/events", (req: Request, res: Response) => {
  try {
    const operationId = readOperationId(req.params.operationId);
    const walletAddress = readWallet((req.body as { walletAddress?: unknown } | undefined)?.walletAddress);
    if (!operationId || !walletAddress) {
      return sendError(res, 400, "INVALID_REVIEW_OPERATION", "A valid operationId and walletAddress are required.");
    }
    const event = parseReviewOperationEvent(req.body);
    const operation = recordReviewOperationEvent(walletAddress, operationId, event);
    res.json({ operation });
  } catch (error) {
    if (sendReviewOperationError(res, error)) return;
    sendError(res, 500, "REVIEW_OPERATION_FAILED", "Failed to record review operation", undefined, undefined, true);
  }
});

/**
 * GET /api/zap/review-operations/:operationId?walletAddress=G...
 */
router.get("/review-operations/:operationId", (req: Request, res: Response) => {
  const operationId = readOperationId(req.params.operationId);
  const walletAddress = readWallet(req.query.walletAddress);
  if (!operationId || !walletAddress) {
    return sendError(res, 400, "INVALID_REVIEW_OPERATION", "A valid operationId and walletAddress are required.");
  }
  const operation = getReviewOperation(walletAddress, operationId);
  if (!operation) {
    return sendError(res, 404, "REVIEW_OPERATION_NOT_FOUND", `No review operation "${operationId}" is recorded for this wallet.`);
  }
  res.json({ operation });
});

export default router;
