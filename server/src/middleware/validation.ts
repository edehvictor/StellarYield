import { Request, Response, NextFunction } from "express";
import { StrKey } from "@stellar/stellar-sdk";
import { sendError } from "../utils/errorResponse";
import { buildTransactionReviewFailureDiagnostics } from "../../../shared/types/transactionReviewDiagnostic";

function zapValidationDiagnostics() {
  return buildTransactionReviewFailureDiagnostics("VALIDATION_FAILED", {
    stage: "request-validation",
  });
}
import { parseStroopsAmount, StroopsMathError } from "../services/stroopsMath";

export function validateWalletAddress(req: Request, res: Response, next: NextFunction): void {
  const address = req.params.address || req.params.walletAddress;
  if (
    !address ||
    typeof address !== "string" ||
    (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address))
  ) {
    sendError(res, 400, "INVALID_ADDRESS", "Invalid Stellar wallet address.");
    return;
  }
  next();
}

export function validatePagination(req: Request, res: Response, next: NextFunction): void {
  const page = parseInt(req.query.page as string);
  const limit = parseInt(req.query.limit as string);
  if ((page && (isNaN(page) || page < 1)) || (limit && (isNaN(limit) || limit < 1 || limit > 100))) {
    sendError(res, 400, "INVALID_PAGINATION", "Invalid page or limit parameters.");
    return;
  }
  next();
}

export function validateZapQuote(req: Request, res: Response, next: NextFunction): void {
  const { inputTokenContract, vaultTokenContract, amountInStroops } = req.body;
  if (!inputTokenContract || !vaultTokenContract || amountInStroops === undefined) {
    sendError(res, 400, "MISSING_FIELDS", "inputTokenContract, vaultTokenContract, and amountInStroops are required.", undefined, undefined, undefined, zapValidationDiagnostics());
    return;
  }
  // Strict, checked parse: rejects negatives, zero, decimals, and values above i128 max.
  try {
    parseStroopsAmount(amountInStroops);
  } catch (e) {
    if (e instanceof StroopsMathError) {
      sendError(res, 400, "INVALID_AMOUNT", e.message, undefined, undefined, undefined, zapValidationDiagnostics());
      return;
    }
    throw e;
  }
  const { slippageTolerance } = req.body;
  if (
    slippageTolerance !== undefined &&
    !(
      (typeof slippageTolerance === "number" ||
        (typeof slippageTolerance === "string" && slippageTolerance.trim() !== "")) &&
      Number.isFinite(Number(slippageTolerance))
    )
  ) {
    sendError(res, 400, "INVALID_SLIPPAGE", "slippageTolerance must be a finite number.", undefined, undefined, undefined, zapValidationDiagnostics());
    return;
  }
  next();
}