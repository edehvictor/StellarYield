import { NextFunction, Request, Response } from "express";

type LogLevel = "info" | "warn" | "error";

function getRequestId(req: Request): string | undefined {
  return (req as unknown as { requestId?: string }).requestId;
}

function log(level: LogLevel, payload: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...payload,
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function requestLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    log("info", {
      requestId: getRequestId(req),
      method: req.method,
      path: req.originalUrl ?? req.path,
      status: res.statusCode,
      durationMs,
    });
  });

  next();
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = getRequestId(req);
  const error =
    err instanceof Error
      ? { name: err.name, message: err.message }
      : { name: "Error", message: "Unexpected error" };

  log("error", {
    requestId,
    method: req.method,
    path: req.originalUrl ?? req.path,
    status: res.statusCode || 500,
    error,
  });

  if (res.headersSent) return;

  res.status(500).json({
    error: "Internal server error.",
    requestId,
  });
}

