import { Request, Response } from "express";
import { ErrorResponse } from "../types/error";

function getRequestId(req: Request): string | undefined {
  return (req as unknown as { requestId?: string }).requestId;
}

export function sendError(
  res: Response,
  statusCode: number,
  error: string,
  message: string,
  details?: unknown,
  requestId?: string
): void {
  const errorResponse: ErrorResponse = { error, message };
  if (requestId !== undefined) {
    errorResponse.requestId = requestId;
  }
  if (details !== undefined) {
    errorResponse.details = details;
  }
  res.status(statusCode).json(errorResponse);
}

export function sendErrorWithRequest(
  req: Request,
  res: Response,
  statusCode: number,
  error: string,
  message: string,
  details?: unknown
): void {
  const requestId = getRequestId(req);
  sendError(res, statusCode, error, message, details, requestId);
}