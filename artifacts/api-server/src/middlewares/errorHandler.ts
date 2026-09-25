import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";
import { AccountLinkError } from "../lib/errors";

/**
 * Terminal error handler: converts anything thrown anywhere in the request
 * pipeline into the stable typed payload declared in the OpenAPI
 * `AccountLinkError` schema.
 *
 * - `AccountLinkError` instances are returned with their original status/code.
 * - Body-parser failures (malformed JSON) become a typed 400.
 * - `ZodError` instances (a response-shape invariant violation) become a
 *   generic 500.
 * - Every other error (database, SDK, programmer error) is logged with its
 *   raw cause and replaced by a generic 500 so raw provider messages never
 *   reach clients.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  let apiError: AccountLinkError;

  if (error instanceof AccountLinkError) {
    apiError = error;
  } else if (isBodyParserClientError(error)) {
    apiError = AccountLinkError.invalidRequest([
      { path: "body", message: "Request body could not be parsed." },
    ]);
  } else if (error instanceof ZodError) {
    apiError = AccountLinkError.internal(error);
  } else {
    apiError = AccountLinkError.internal(error);
  }

  if (apiError.status >= 500) {
    logger.error(
      { err: apiError.cause ?? error, reqId: req.id },
      "Request failed with an unexpected error",
    );
  }

  res.status(apiError.status).json(apiError.toBody());
};

/**
 * Detects body-parser errors (`entity.parse.failed`, `entity.too.large`, ...)
 * which carry a 4xx `status` and a machine-readable `type`.
 */
function isBodyParserClientError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { type?: unknown; status?: unknown };

  return (
    typeof candidate.type === "string" &&
    candidate.type.startsWith("entity.") &&
    typeof candidate.status === "number" &&
    candidate.status >= 400 &&
    candidate.status < 500
  );
}
