import { Request, Response } from "express";
import { ErrorResponse } from "../types/error";
import {
  lookupExportFailure,
  toExportFailure,
  type ResolvedExportFailure,
} from "../types/exportFailure";

function getRequestId(req: Request): string | undefined {
  return (req as unknown as { requestId?: string }).requestId;
}

export function sendError(
  res: Response,
  statusCode: number,
  error: string,
  message: string,
  details?: unknown,
  requestId?: string,
  recoverable?: boolean
): void {
  const errorResponse: ErrorResponse = { error, message };
  if (requestId !== undefined) {
    errorResponse.requestId = requestId;
  }
  if (details !== undefined) {
    errorResponse.details = details;
  }
  if (recoverable !== undefined) {
    errorResponse.recoverable = recoverable;
  }
  res.status(statusCode).json(errorResponse);
}

export function sendErrorWithRequest(
  req: Request,
  res: Response,
  statusCode: number,
  error: string,
  message: string,
  details?: unknown,
  recoverable?: boolean
): void {
  const requestId = getRequestId(req);
  sendError(res, statusCode, error, message, details, requestId, recoverable);
}

// ── Structured export failures (#1122) ────────────────────────────────────

export interface ExportErrorOptions {
  /** Explicit machine-readable code (legacy route codes resolve from the catalog). */
  code?: string;
  /** Explicit HTTP status override. */
  statusCode?: number;
  /** Explicit human-readable message override. */
  message?: string;
  /** Optional structured details to attach. */
  details?: unknown;
  /** Request correlation id, when available. */
  requestId?: string;
}

/**
 * Body emitted for export failures. Keeps the legacy `{ error, message }`
 * fields so existing clients keep working, and adds the stable `code`,
 * `category`, and `retryable` fields the frontend can branch on
 * (validation vs. timeout vs. service failure).
 */
export interface ExportErrorResponse extends ErrorResponse {
  code: string;
  category: string;
  retryable: boolean;
}

/**
 * Send a structured export failure response.
 *
 * When `error` is (or wraps) an `ExportFailureError`, its resolved fields are
 * used as-is. Otherwise the value is classified deterministically via
 * `toExportFailure`. Explicit `options` always win over the resolved values,
 * which lets legacy routes keep their exact status codes and messages while
 * gaining the machine-readable classification.
 */
export function sendExportError(
  res: Response,
  error: unknown,
  options: ExportErrorOptions = {},
): void {
  const resolved: ResolvedExportFailure = toExportFailure(error);
  const code = options.code ?? resolved.code;
  const descriptor = lookupExportFailure(code);
  const category = descriptor?.category ?? resolved.category;
  const retryable = descriptor?.retryable ?? resolved.retryable;
  const statusCode = options.statusCode ?? descriptor?.httpStatus ?? resolved.httpStatus;
  const message = options.message ?? resolved.message;
  const details = options.details ?? resolved.details;

  const body: ExportErrorResponse = { error: code, message, code, category, retryable };
  if (options.requestId !== undefined) {
    body.requestId = options.requestId;
  }
  if (details !== undefined) {
    body.details = details;
  }
  res.status(statusCode).json(body);
}