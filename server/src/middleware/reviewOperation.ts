/**
 * Optional operation identity for the transaction review API (#1888).
 *
 * The idempotent effect itself lives on-chain (the zap contract's `op_id`).
 * These read-only review routes accept the same id so a client can correlate
 * quote/verify failures with the exact logical deposit and so a malformed id
 * is rejected at the boundary instead of being echoed into diagnostic text.
 */

import type { NextFunction, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";
import { buildTransactionReviewFailureDiagnostics } from "../../../shared/types/transactionReviewDiagnostic";
import { isValidTransactionReviewOperationId } from "../../../shared/types/transactionReviewOperation";

export const REVIEW_OPERATION_HEADER = "x-operation-identity";

export function getReviewOperationId(req: Request): string | undefined {
  return (req as Request & { reviewOperationId?: string }).reviewOperationId;
}

export function reviewOperationIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const raw = req.header(REVIEW_OPERATION_HEADER);
  if (raw === undefined) {
    next();
    return;
  }

  const operationId = raw.trim();
  if (!isValidTransactionReviewOperationId(operationId)) {
    sendError(
      res,
      400,
      "INVALID_OPERATION_IDENTITY",
      "The review operation identity is malformed.",
      undefined,
      undefined,
      false,
      buildTransactionReviewFailureDiagnostics("VALIDATION_FAILED", {
        stage: "request-validation",
      }),
    );
    return;
  }

  (req as Request & { reviewOperationId?: string }).reviewOperationId = operationId;
  res.setHeader("X-Operation-Identity", operationId);
  next();
}
