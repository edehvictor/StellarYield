import { Response } from "express";
import { ErrorResponse } from "../types/error";

export function sendError(
  res: Response,
  statusCode: number,
  error: string,
  message: string,
  details?: unknown
): void {
  const errorResponse: ErrorResponse = { error, message };
  if (details !== undefined) {
    errorResponse.details = details;
  }
  res.status(statusCode).json(errorResponse);
}