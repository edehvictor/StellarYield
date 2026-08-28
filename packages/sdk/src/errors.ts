import { VaultError } from "./generated/yield_vault";

/**
 * Lifecycle phase in which an SDK error originated. Lets callers branch on
 * "where did this fail" instead of parsing error messages/class names alone.
 */
export type SdkErrorPhase = "simulate" | "sign" | "submit" | "poll" | "restore";

export const VAULT_ERROR_MESSAGES: Record<number, string> = {
  1: "Contract not initialized",
  2: "Contract already initialized",
  3: "Amount must be strictly greater than zero",
  4: "Insufficient shares available for operation",
  5: "Caller is unauthorized for this operation",
  6: "Total vault supply is zero",
  7: "Vault operations are currently paused",
  8: "Timelock is currently active",
  9: "Invalid oracle price",
  10: "Slippage tolerance exceeded",
  11: "Storage key not found",
  2001: "Invalid donation basis points (must be 0-10,000)",
  2002: "Charity address is not on protocol whitelist",
};

export abstract class SorobanSdkError extends Error {
  /** Lifecycle phase in which this error was raised, when known. */
  public readonly phase?: SdkErrorPhase;
  /** Whether retrying the operation that produced this error may succeed. */
  public readonly retryable: boolean;

  constructor(message: string, phase?: SdkErrorPhase, retryable = false) {
    super(message);
    this.name = this.constructor.name;
    this.phase = phase;
    this.retryable = retryable;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ContractExecutionError extends SorobanSdkError {
  public readonly errorCode: number;
  public readonly errorName: string;
  public readonly rawResultXdr?: string;
  public readonly diagnosticEvents?: string[];

  constructor(
    errorCode: number,
    errorName: string,
    message: string,
    rawResultXdr?: string,
    diagnosticEvents?: string[],
    phase: SdkErrorPhase = "submit"
  ) {
    super(`Contract Execution Error [${errorCode} ${errorName}]: ${message}`, phase, false);
    this.errorCode = errorCode;
    this.errorName = errorName;
    this.rawResultXdr = rawResultXdr;
    this.diagnosticEvents = diagnosticEvents;
  }
}

export class WrongNetworkError extends SorobanSdkError {
  public readonly expectedNetwork: string;
  public readonly actualNetwork: string;

  constructor(expectedNetwork: string, actualNetwork: string) {
    super(
      `Network passphrase mismatch: expected '${expectedNetwork}', received '${actualNetwork}'`,
      "sign",
      false
    );
    this.expectedNetwork = expectedNetwork;
    this.actualNetwork = actualNetwork;
  }
}

export class SpecMismatchError extends SorobanSdkError {
  public readonly expectedHash: string;
  public readonly actualHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(
      `Contract spec hash mismatch: expected '${expectedHash}', got '${actualHash}'`,
      "simulate",
      false
    );
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export class StaleSimulationError extends SorobanSdkError {
  public readonly currentLedger: number;
  public readonly validUntilLedger: number;

  constructor(currentLedger: number, validUntilLedger: number) {
    super(
      `Simulation snapshot is stale (valid until ledger ${validUntilLedger}, current ledger ${currentLedger})`,
      "simulate",
      true
    );
    this.currentLedger = currentLedger;
    this.validUntilLedger = validUntilLedger;
  }
}

export class SubmissionTimeoutError extends SorobanSdkError {
  public readonly txHash: string;
  public readonly timeoutMs: number;

  constructor(txHash: string, timeoutMs: number) {
    super(
      `Transaction '${txHash}' pending inclusion timed out after ${timeoutMs}ms. Transaction may still land on-chain; use recoverTransaction() to check.`,
      "poll",
      true
    );
    this.txHash = txHash;
    this.timeoutMs = timeoutMs;
  }
}

export class WalletRejectedError extends SorobanSdkError {
  constructor(reason?: string) {
    super(
      reason ? `Wallet rejected signature: ${reason}` : "Wallet rejected signature",
      "sign",
      true
    );
  }
}

export class InvalidXdrError extends SorobanSdkError {
  public readonly rawXdr: string;

  constructor(rawXdr: string, details?: string) {
    super(`Failed to parse or validate XDR string: ${details || "Invalid XDR"}`, "sign", false);
    this.rawXdr = rawXdr;
  }
}

export class MissingAuthError extends SorobanSdkError {
  public readonly requiredAddress: string;

  constructor(requiredAddress: string) {
    super(
      `Transaction simulation requires authorization entry for '${requiredAddress}'`,
      "simulate",
      false
    );
    this.requiredAddress = requiredAddress;
  }
}

/** HTTP / fetch request timed out before a response arrived. */
export class ApiTimeoutError extends SorobanSdkError {
  public readonly timeoutMs: number;
  public readonly path: string;

  constructor(path: string, timeoutMs: number) {
    super(`API request to '${path}' timed out after ${timeoutMs}ms`, undefined, true);
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}

/** Underlying network failure (DNS, connection reset, offline, etc.). */
export class ApiNetworkError extends SorobanSdkError {
  public readonly path: string;
  public readonly cause?: unknown;

  constructor(path: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause != null ? String(cause) : "unknown";
    super(`API network error at '${path}': ${detail}`, undefined, true);
    this.path = path;
    this.cause = cause;
  }
}

/** Non-OK HTTP response from the backend API. */
export class ApiHttpError extends SorobanSdkError {
  public readonly path: string;
  public readonly status: number;
  public readonly statusText: string;

  constructor(path: string, status: number, statusText: string, retryable: boolean) {
    super(`API error (${status} ${statusText}) at ${path}`, undefined, retryable);
    this.path = path;
    this.status = status;
    this.statusText = statusText;
  }
}

/**
 * Restore preamble data returned by a `SimulateTransactionRestoreResponse`.
 * `transactionData` is a `SorobanDataBuilder` instance from `@stellar/stellar-sdk`
 * (kept as `unknown` here so `errors.ts` has no dependency on that package's types).
 */
export interface RestorePreambleInfo {
  minResourceFee: string;
  transactionData: unknown;
}

export class RestoreRequiredError extends SorobanSdkError {
  public readonly minResourceFee: string;
  public readonly restorePreamble?: RestorePreambleInfo;

  constructor(minResourceFee: string, restorePreamble?: RestorePreambleInfo) {
    super(
      `Simulation indicates expired ledger entries requiring a restore footprint operation (min resource fee ${minResourceFee})`,
      "restore",
      true
    );
    this.minResourceFee = minResourceFee;
    this.restorePreamble = restorePreamble;
  }
}

/**
 * Normalized finality classification for a submitted transaction's poll
 * result, so callers can branch on a small stable set of outcomes instead of
 * raw RPC status strings.
 */
export interface FinalityResult {
  status: "success" | "failed" | "timeout" | "unknown";
  retryable: boolean;
}

export function classifyFinality(
  rpcStatus: string | undefined,
  timedOut: boolean
): FinalityResult {
  if (rpcStatus === "SUCCESS") {
    return { status: "success", retryable: false };
  }
  if (rpcStatus === "FAILED") {
    return { status: "failed", retryable: false };
  }
  if (rpcStatus === "NOT_FOUND" && timedOut) {
    return { status: "timeout", retryable: true };
  }
  return { status: "unknown", retryable: true };
}

export function decodeVaultError(code: number): { name: string; message: string } {
  const generatedMeta = (VaultError as Record<number, { message: string }>)[code];
  const name = generatedMeta ? generatedMeta.message : `UnknownError_${code}`;
  const message = VAULT_ERROR_MESSAGES[code] || `Contract error code ${code}`;
  return { name, message };
}

export function parseContractError(
  error: unknown,
  rawResultXdr?: string,
  diagnosticEvents?: string[],
  phase: SdkErrorPhase = "submit"
): SorobanSdkError {
  if (error instanceof SorobanSdkError) {
    return error;
  }

  const errString = String(error);
  // Match numeric contract error code patterns e.g. Error(Contract, #5) or ErrorCode(5)
  const codeMatch = errString.match(/(?:Error\(Contract,\s*#(\d+)\)|ErrorCode\((\d+)\)|Error\s*(\d+))/i);
  if (codeMatch) {
    const codeNum = parseInt(codeMatch[1] || codeMatch[2] || codeMatch[3], 10);
    const { name, message } = decodeVaultError(codeNum);
    return new ContractExecutionError(codeNum, name, message, rawResultXdr, diagnosticEvents, phase);
  }

  return new ContractExecutionError(
    999,
    "GenericSorobanError",
    errString || "Unknown Soroban contract execution failure",
    rawResultXdr,
    diagnosticEvents,
    phase
  );
}
