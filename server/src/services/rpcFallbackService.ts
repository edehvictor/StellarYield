/**
 * rpcFallbackService.ts — Issue #1179
 *
 * Provides structured logging for RPC provider fallback rotation during
 * read operations. Logs when the system rotates between RPC providers
 * so operators can identify provider instability.
 *
 * Security: Does not log sensitive wallet addresses or request payloads.
 */

export interface RpcEndpoint {
  url: string;
  label: string;
}

export interface RpcRotationLogEntry {
  timestamp: string;
  originalProvider: string;
  fallbackProvider: string;
  route: string;
  reason: string;
}

export interface RpcReadContext {
  route: string;
  originalProvider: string;
}

/**
 * In-memory rotation log for recent fallback events.
 * Bounded to the most recent entries to prevent unbounded memory growth.
 */
const MAX_LOG_ENTRIES = 100;
const rotationLog: RpcRotationLogEntry[] = [];

/**
 * Classifies whether an error is retryable (network-level, transient).
 * Does not inspect sensitive request data.
 */
export function isRetryableRpcError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as Record<string, unknown>;

  if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ETIMEDOUT") {
    return true;
  }
  if (err.response && typeof err.response === "object" && err.response !== null) {
    const response = err.response as Record<string, unknown>;
    if (typeof response.status === "number") {
      return response.status >= 500;
    }
  }
  if (err.message && typeof err.message === "string") {
    if (/timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(err.message)) {
      return true;
    }
  }
  return false;
}

/**
 * Derives a human-readable reason from the error that triggered rotation.
 * Strips any sensitive data from the message.
 */
export function deriveRotationReason(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;
    if (typeof err.code === "string") {
      return `Error code: ${err.code}`;
    }
    if (err.response && typeof err.response === "object") {
      const response = err.response as Record<string, unknown>;
      if (typeof response.status === "number") {
        return `HTTP ${response.status}`;
      }
    }
  }
  if (error instanceof Error) {
    const msg = error.message || "Unknown error";
    if (/timeout/i.test(msg)) return "Request timeout";
    if (/network|ECONNREFUSED|ECONNRESET/i.test(msg)) return "Network error";
    if (/5\d{2}/.test(msg)) return "Server error";
  }
  return "Provider failure";
}

/**
 * Logs a fallback rotation event when a read operation rotates
 * between RPC providers.
 */
export function logRpcRotation(ctx: RpcReadContext, reason: string): void {
  const entry: RpcRotationLogEntry = {
    timestamp: new Date().toISOString(),
    originalProvider: ctx.originalProvider,
    fallbackProvider: ctx.route,
    route: ctx.route,
    reason,
  };

  rotationLog.push(entry);
  if (rotationLog.length > MAX_LOG_ENTRIES) {
    rotationLog.shift();
  }

  console.warn("[rpc-fallback] Provider rotation", {
    originalProvider: ctx.originalProvider,
    route: ctx.route,
    reason,
  });
}

/**
 * Executes a read operation with automatic fallback rotation across
 * multiple RPC providers.
 *
 * Tries each provider in order; on retryable failure, logs the rotation
 * and moves to the next provider.
 */
export async function executeWithRpcFallback<T>(
  providers: RpcEndpoint[],
  readFn: (provider: RpcEndpoint) => Promise<T>,
  route: string,
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    try {
      return await readFn(provider);
    } catch (error) {
      lastError = error;

      if (isRetryableRpcError(error) && i < providers.length - 1) {
        const nextProvider = providers[i + 1];
        const reason = deriveRotationReason(error);
        logRpcRotation(
          { originalProvider: provider.label, route },
          `${reason} → rotating to ${nextProvider.label}`,
        );
      } else {
        throw error;
      }
    }
  }

  throw lastError;
}

/**
 * Returns a copy of the recent rotation log entries.
 */
export function getRotationLog(): RpcRotationLogEntry[] {
  return [...rotationLog];
}

/**
 * Clears the rotation log (useful for tests).
 */
export function clearRotationLog(): void {
  rotationLog.length = 0;
}
