/**
 * Catalog-aware error response helper
 *
 * Routes use `catalogError` to send a response that conforms to the shared
 * `ErrorResponse` shape AND carries the stable error code + retry category
 * from the API error catalog.
 */

import { Response } from "express";
import type { ApiErrorDescriptor } from "../types/apiErrorCatalog";

export interface CatalogErrorBody {
  /** Stable machine-readable error code from the catalog. */
  code: string;
  /** Human-readable error message (overrides the descriptor default when provided). */
  message: string;
  /** How the client should respond. */
  retryCategory: string;
  /** Optional structured details (field errors, upstream messages, etc.). */
  details?: unknown;
}

/**
 * Send an error response derived from the API error catalog.
 *
 * @param res        - Express response object
 * @param descriptor - Entry from `API_ERRORS`
 * @param message    - Override the default message when more context is available
 * @param details    - Optional extra payload attached as `details`
 */
export function catalogError(
  res: Response,
  descriptor: ApiErrorDescriptor,
  message?: string,
  details?: unknown,
): void {
  const body: CatalogErrorBody = {
    code: descriptor.code,
    message: message ?? descriptor.defaultMessage,
    retryCategory: descriptor.retryCategory,
    ...(details !== undefined ? { details } : {}),
  };
  res.status(descriptor.httpStatus).json(body);
}
