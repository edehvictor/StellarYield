/**
 * Contract Call Timeout Classification (#1292)
 *
 * Deterministically classifies errors from Soroban RPC contract calls so API
 * responses can return typed, stable error codes instead of raw provider
 * messages. Classification keys off error identity (`name`, `code`, sentinel
 * marker) rather than parsing provider message text.
 *
 * `markContractCallTimeout` wraps a promise with a deadline. When the deadline
 * fires it rejects with a `ContractCallTimeoutError` carrying a single source
 * of truth: `code: "CONTRACT_CALL_TIMEOUT"`, `retryable: true`, `kind: "timeout"`.
 */

export type ContractCallErrorKind =
  | "timeout"
  | "network"
  | "invalid_argument"
  | "contract_error"
  | "unknown";

export interface ContractCallErrorClassification {
  /** Stable machine-readable kind. Callers branch on this. */
  kind: ContractCallErrorKind;
  /** Stable machine-readable code for API responses. */
  code: string;
  /** Whether retrying the call is expected to succeed. */
  retryable: boolean;
  /** Internal detail (never rendered verbatim as the only error surface). */
  message: string;
}

const TIMEOUT_SENTINEL_CODE = "CONTRACT_CALL_TIMEOUT";

export class ContractCallTimeoutError extends Error {
  readonly code = TIMEOUT_SENTINEL_CODE;
  readonly kind: ContractCallErrorKind = "timeout";
  readonly retryable = true;
  /** ISO timestamp of when the deadline fired. */
  readonly at: string;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`Contract call timed out after ${timeoutMs}ms`);
    this.name = "ContractCallTimeoutError";
    this.at = new Date().toISOString();
    if (cause !== undefined && cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/**
 * Run `task` and reject with a typed `ContractCallTimeoutError` if it does not
 * settle within `timeoutMs`. The typed error is what callers use to produce a
 * deterministic API response — no raw provider message reaches the response.
 */
export async function markContractCallTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ContractCallTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isTimeoutLike(error: unknown): boolean {
  if (error instanceof ContractCallTimeoutError) return true;
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    if (error.name === "TimeoutError") return true;
    if ((error.name ?? error.message).toLowerCase().includes("timeout")) return true;
  }
  return false;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Classify an arbitrary thrown value from a contract call into a typed result.
 * Never throws. Bias toward stable codes; provider text only feeds the private
 * `message` field for diagnostics.
 */
export function classifyContractCallError(
  error: unknown,
): ContractCallErrorClassification {
  if (isTimeoutLike(error)) {
    return {
      kind: "timeout",
      code: TIMEOUT_SENTINEL_CODE,
      retryable: true,
      message: error instanceof Error ? error.message : "Contract call timed out",
    };
  }

  const code =
    error !== null && typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;

  if (code && NETWORK_CODES.has(code.toUpperCase())) {
    return {
      kind: "network",
      code: "CONTRACT_CALL_NETWORK_ERROR",
      retryable: true,
      message: error instanceof Error ? error.message : "Contract call network error",
    };
  }

  const isContractError = code === "CONTRACT_ERROR" ||
    code === "CONTRACT_CALL_FAILED" ||
    (error instanceof Error && error.name === "ContractError" && code === undefined);

  if (isContractError) {
    return {
      kind: "contract_error",
      code: "CONTRACT_CALL_REVERTED",
      retryable: false,
      message: error instanceof Error ? error.message : "Contract call reverted",
    };
  }

  if (code === "INVALID_ARGUMENT" || code === "INVALID_INPUT") {
    return {
      kind: "invalid_argument",
      code: "CONTRACT_CALL_INVALID_ARGUMENT",
      retryable: false,
      message: error instanceof Error ? error.message : "Contract call had invalid arguments",
    };
  }

  return {
    kind: "unknown",
    code: "CONTRACT_CALL_UNKNOWN",
    retryable: false,
    message: error instanceof Error ? error.message : "Unknown contract call failure",
  };
}