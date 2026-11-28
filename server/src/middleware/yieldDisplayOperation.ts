import type { NextFunction, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";
import { isValidYieldDisplayOperationId } from "../../../shared/types/yieldDataDisplayOperation";

export const YIELD_DISPLAY_OPERATION_HEADER = "x-operation-identity";

export function getYieldDisplayOperationId(req: Request): string | undefined {
  return (req as Request & { yieldDisplayOperationId?: string }).yieldDisplayOperationId;
}

export function yieldDisplayOperationIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const raw = req.header(YIELD_DISPLAY_OPERATION_HEADER);
  if (raw === undefined) {
    next();
    return;
  }

  const operationId = raw.trim();
  if (!isValidYieldDisplayOperationId(operationId)) {
    sendError(
      res,
      400,
      "INVALID_YIELD_DISPLAY_OPERATION_IDENTITY",
      "The yield display operation identity is malformed.",
      { stage: "request-validation" },
      undefined,
      false,
    );
    return;
  }

  (req as Request & { yieldDisplayOperationId?: string }).yieldDisplayOperationId = operationId;
  res.setHeader("X-Operation-Identity", operationId);
  next();
}
