import { VaultError } from "./generated/yield_vault";
import {
  type SdkDiagnostic,
  buildSdkFailureDiagnostics,
  redactDiagnosticText,
} from "./diagnostics";
import {
  buildSimulationFailureDiagnostics,
  classifySimulationFailure,
  type SimulationDiagnostic,
  type SimulationDiagnosticContext,
  type SimulationFailureCode,
  type SimulationStage,
} from "./simulationDiagnostics";

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
  2003: "Administrative operation has expired",
  2004: "Administrative operation was already executed",
  2005: "Cross-contract call is unauthorized or on the wrong network",
  2006: "Fee recipient is invalid",
  2007: "Donation amount is below the minimum",
  2008: "Deposit exceeds the configured liquidity depth",
  2009: "Storage is already at the requested version",
  2010: "Storage schema version does not match the contract",
};

export abstract class SorobanSdkError extends Error {
  /** Lifecycle phase in which this error was raised, when known. */
  public readonly phase?: SdkErrorPhase;
  /** Whether retrying the operation that produced this error may succeed. */
  public readonly retryable: boolean;
  /** Literal marker certifying that diagnostics contain no sensitive values. */
  public readonly privacySafe: boolean;
  /**
   * Privacy-safe diagnostics naming the failed stage and remediation path.
   * Present on simulation-path errors; never contains raw error payloads.
   * Endpoint/lifecycle errors carry `SdkDiagnostic`s, simulation-path errors
   * carry `SimulationDiagnostic`s.
   */
  public diagnostics?: readonly SdkDiagnostic[] | readonly SimulationDiagnostic[];

  constructor(
    message: string,
    phase?: SdkErrorPhase,
    retryable = false,
    diagnostics?: readonly SdkDiagnostic[]
  ) {
    super(message);
    this.name = this.constructor.name;
    this.phase = phase;
    this.retryable = retryable;
    this.diagnostics = diagnostics;
    this.privacySafe = true;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when SDK endpoint configuration is missing or invalid.
 */
export class SdkEndpointError extends SorobanSdkError {
  public readonly validationErrors?: readonly string[];

  constructor(
    message: string,
    diagnostics: readonly SdkDiagnostic[],
    validationErrors?: readonly string[],
    phase: SdkErrorPhase = "simulate",
    retryable = false
  ) {
    super(message, phase, retryable, diagnostics);
    this.name = "SdkEndpointError";
    this.validationErrors = validationErrors;
  }
}

export interface DiagnosticContext {
  stage: SdkErrorPhase;
  remediation: string;
}

export function diagnosticContext(phase: SdkErrorPhase, retryable: boolean): DiagnosticContext {
  const remediation = retryable
    ? "retry after refreshing the current network and account state"
    : phase === "simulate"
      ? "review the request and contract configuration"
      : phase === "sign"
        ? "verify the wallet account and network"
        : "inspect the transaction status before retrying";
  return { stage: phase, remediation };
}

export class ContractExecutionError extends SorobanSdkError {
  public readonly errorCode: number;
  public readonly errorName: string;
  public readonly rawResultXdr?: string;
  public readonly diagnosticEvents?: string[];
  public readonly diagnosticContext: DiagnosticContext;

  constructor(
    errorCode: number,
    errorName: string,
    message: string,
    rawResultXdr?: string,
    diagnosticEvents?: string[],
    phase: SdkErrorPhase = "submit",
    diagnostics?: readonly SdkDiagnostic[]
  ) {
    const hasDiagContext = Array.isArray(diagnosticEvents) && diagnosticEvents.length > 0;
    const resolvedDiagnostics =
      diagnostics ??
      buildSdkFailureDiagnostics(
        hasDiagContext ? "VALIDATION_FAILED" : "CONTEXT_INSUFFICIENT",
        {
          stage: phase,
          summary: hasDiagContext
            ? `Contract execution failed [${errorCode} ${errorName}].`
            : "Contract execution failed without diagnostic events.",
          remediation: hasDiagContext
            ? "Inspect contract parameters and simulate again; existing balances and state are unchanged."
            : "Enable verbose RPC diagnostic events or verify endpoint connectivity; existing state was preserved.",
          retryable: false,
          preserveState: true,
        }
      );

    super(
      `Contract Execution Error [${errorCode} ${errorName}]: ${message}`,
      phase,
      false,
      resolvedDiagnostics
    );
    this.errorCode = errorCode;
    this.errorName = errorName;
    this.rawResultXdr = rawResultXdr;
    this.diagnosticEvents = diagnosticEvents;
    this.diagnosticContext = diagnosticContext(phase, false);
  }
}

/**
 * A simulation-path failure that carries privacy-safe diagnostics.
 *
 * Raised when the simulation fails without a decodable contract error code or
 * any diagnostic events (insufficient diagnostic context), and for other
 * simulation-stage failures that should not leak raw upstream error text.
 */
export class SimulationDiagnosticsError extends SorobanSdkError {
  /** Stable code of the primary diagnostic. */
  public readonly code: SimulationFailureCode;
  /** Stage that was reached but not completed. */
  public readonly stage: SimulationStage;
  /** Privacy-safe diagnostics: primary failure first, state preservation last. */
  public readonly diagnostics: SimulationDiagnostic[];
  /** Next action, mirroring `diagnostics[0].remediation`. */
  public readonly remediation: string;
  /** Contract method whose prepare call failed (a fixed SDK identifier). */
  public readonly method?: string;
  /** Privacy-safe failure context: event count and decoded code only. */
  public readonly context: SimulationDiagnosticContext;

  constructor(
    diagnostics: SimulationDiagnostic[],
    options: {
      method?: string;
      context?: SimulationDiagnosticContext;
    } = {}
  ) {
    const primary = diagnostics[0];
    super(
      `Simulation failed [${primary.code} at ${primary.stage}]: ${primary.summary}`,
      "simulate",
      primary.retryable
    );
    this.code = primary.code as SimulationFailureCode;
    this.stage = primary.stage;
    this.diagnostics = diagnostics;
    this.remediation = primary.remediation;
    this.method = options.method;
    this.context = options.context ?? {
      diagnosticEventCount: 0,
      hasErrorMessage: false,
    };
  }
}

/** Attach diagnostics to an existing typed error without changing its type. */
export function attachSimulationDiagnostics<T extends SorobanSdkError>(
  error: T,
  diagnostics: SimulationDiagnostic[]
): T {
  // Simulation diagnostics supersede any endpoint-shaped defaults the error was
  // constructed with (for example an InvalidAmountError's validation
  // diagnostics), so callers always see the simulation stage that failed.
  error.diagnostics = diagnostics;
  return error;
}

export interface ToSimulationErrorOptions {
  /** Contract method whose prepare call failed. */
  method?: string;
  /** Explicit context from an inspected simulation response. */
  context?: Partial<SimulationDiagnosticContext>;
}

/**
 * Normalize any caught simulate-stage value into a typed SDK error that
 * carries privacy-safe diagnostics.
 *
 * Known typed errors (`InvalidAmountError`, `RestoreRequiredError`, and
 * contract errors with a real VaultError code) keep their class and gain
 * `diagnostics`, so existing `instanceof` handling keeps working. Failures
 * without a decodable code or diagnostic events become a
 * {@link SimulationDiagnosticsError} with `CONTEXT_INSUFFICIENT`, and the raw
 * upstream message is deliberately not propagated.
 */
export function toSimulationError(
  error: unknown,
  options: ToSimulationErrorOptions = {}
): SorobanSdkError {
  if (error instanceof SimulationDiagnosticsError) return error;

  if (error instanceof RestoreRequiredError) {
    return attachSimulationDiagnostics(
      error,
      buildSimulationFailureDiagnostics("RESTORE_REQUIRED", { stage: "restore" })
    );
  }

  if (error instanceof InvalidAmountError) {
    return attachSimulationDiagnostics(
      error,
      buildSimulationFailureDiagnostics("VALIDATION_FAILED", {
        stage: "input-validation",
      })
    );
  }

  const parsed =
    error instanceof SorobanSdkError
      ? error
      : parseContractError(error, undefined, undefined, "simulate");

  if (parsed instanceof ContractExecutionError && parsed.errorCode !== 999) {
    return attachSimulationDiagnostics(
      parsed,
      buildSimulationFailureDiagnostics("SIMULATION_FAILED", { stage: "simulation" })
    );
  }

  const classified = classifySimulationFailure({ error, context: options.context });
  const diagnostics = buildSimulationFailureDiagnostics(classified.code, {
    stage: classified.stage,
  });

  return new SimulationDiagnosticsError(diagnostics, {
    method: options.method,
    context: classified.context,
  });
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

export class UnsupportedNetworkError extends SorobanSdkError {
  public readonly code = "unsupported_network" as const;
  public readonly network: string;
  public readonly supportedNetworks: readonly string[];

  constructor(network: string, supportedNetworks: readonly string[]) {
    super(
      `Unsupported network id: '${network}'. Supported networks are: ${supportedNetworks.join(", ")}.`,
      "simulate",
      false
    );
    this.network = network;
    this.supportedNetworks = supportedNetworks;
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

/**
 * Raised when a token amount cannot be represented exactly in base units,
 * e.g. an unsafe JavaScript integer or a fractional number.
 */
export class InvalidAmountError extends SorobanSdkError {
  public readonly code = "invalid_amount" as const;
  public readonly field: string;
  public readonly value: unknown;

  constructor(field: string, value: unknown, reason: string) {
    const diagnostics = buildSdkFailureDiagnostics("VALIDATION_FAILED", {
      stage: "request-validation",
      summary: `Amount validation failed for field '${field}'.`,
      remediation: "Provide a non-negative integer amount within safe integer bounds; existing balances are unchanged.",
      retryable: false,
    });
    super(`Invalid ${field}: ${reason}`, "simulate", false, diagnostics);
    this.field = field;
    this.value = value;
  }
}

export class StaleSimulationError extends SorobanSdkError {
  public readonly currentLedger: number;
  public readonly validUntilLedger: number;
  public readonly expectedFingerprint?: string | null;
  public readonly actualFingerprint?: string | null;
  public readonly statePreserved: boolean;

  constructor(
    currentLedger: number,
    validUntilLedger: number,
    details: {
      expectedFingerprint?: string | null;
      actualFingerprint?: string | null;
      statePreserved?: boolean;
    } = {}
  ) {
    super(
      `Simulation snapshot is stale (valid until ledger ${validUntilLedger}, current ledger ${currentLedger})`,
      "simulate",
      true
    );
    this.currentLedger = currentLedger;
    this.validUntilLedger = validUntilLedger;
    this.expectedFingerprint = details.expectedFingerprint ?? null;
    this.actualFingerprint = details.actualFingerprint ?? null;
    this.statePreserved = details.statePreserved ?? true;
  }
}

export class StaleSimulationConfigError extends SorobanSdkError {
  public readonly code = "SIMULATION_CONFIG_STALE" as const;
  public readonly expectedFingerprint: string | null;
  public readonly actualFingerprint: string | null;
  /** Number of simulation attempts completed before the stale result. */
  public readonly attempts: number;
  public readonly statePreserved: boolean;
  public readonly preservedState?: unknown;

  constructor(
    message: string,
    details: {
      expectedFingerprint?: string | null;
      actualFingerprint?: string | null;
      attempts?: number;
      statePreserved?: boolean;
      preservedState?: unknown;
    } = {}
  ) {
    super(message, "simulate", true);
    this.name = "StaleSimulationConfigError";
    this.expectedFingerprint = details.expectedFingerprint ?? null;
    this.actualFingerprint = details.actualFingerprint ?? null;
    this.attempts = details.attempts ?? 1;
    this.statePreserved = details.statePreserved ?? true;
    this.preservedState = details.preservedState;
  }
}

export function isStaleSimulationConfigError(
  error: unknown
): error is StaleSimulationConfigError {
  return (
    error instanceof StaleSimulationConfigError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "SIMULATION_CONFIG_STALE")
  );
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

  constructor(path: string, timeoutMs: number, diagnostics?: readonly SdkDiagnostic[]) {
    const resolvedDiagnostics =
      diagnostics ??
      buildSdkFailureDiagnostics("ENDPOINT_UNAVAILABLE", {
        stage: "network-dispatch",
        summary: `API request to endpoint timed out after ${timeoutMs}ms.`,
        remediation: "Check endpoint latency or retry with backoff; existing state was preserved.",
        retryable: true,
      });
    super(`API request to '${path}' timed out after ${timeoutMs}ms`, undefined, true, resolvedDiagnostics);
    this.path = path;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Caller-initiated cancellation via AbortSignal (route change, input edit, unmount).
 * Distinct from {@link ApiTimeoutError}; not retryable.
 */
export class ApiCancelledError extends SorobanSdkError {
  public readonly path: string;
  public readonly cancelled = true as const;

  constructor(path: string, reason?: string) {
    super(
      reason
        ? `API request to '${path}' was cancelled: ${reason}`
        : `API request to '${path}' was cancelled`,
      undefined,
      false
    );
    this.path = path;
  }
}

export class ProviderConnectionError extends SorobanSdkError {
  constructor(public readonly providerName: string, reason?: string) {
    super(
      reason
        ? `Failed to connect to '${providerName}': ${reason}`
        : `Failed to connect to '${providerName}'`,
      "sign",
      false
    );
    this.providerName = providerName;
  }
}

export class ProviderMethodError extends SorobanSdkError {
  constructor(
    public readonly providerName: string,
    public readonly method: string,
    reason?: string
  ) {
    super(
      reason
        ? `Provider '${providerName}' does not support method '${method}': ${reason}`
        : `Provider '${providerName}' does not support method '${method}'`,
      "sign",
      false
    );
    this.providerName = providerName;
    this.method = method;
  }
}

export class ProviderPermissionError extends SorobanSdkError {
  constructor(public readonly providerName: string, reason?: string) {
    super(
      reason
        ? `Permission denied by '${providerName}': ${reason}`
        : `Permission denied by '${providerName}'`,
      "sign",
      true
    );
    this.providerName = providerName;
  }
}

/** True when an error represents intentional request cancellation (not a timeout). */
export function isApiCancellation(error: unknown): boolean {
  if (error instanceof ApiCancelledError) return true;
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { cancelled?: boolean }).cancelled === true
  ) {
    return true;
  }
  return false;
}

/** Underlying network failure (DNS, connection reset, offline, etc.). */
export class ApiNetworkError extends SorobanSdkError {
  public readonly path: string;
  public readonly cause?: unknown;

  constructor(path: string, cause?: unknown, diagnostics?: readonly SdkDiagnostic[]) {
    const detail = cause instanceof Error ? cause.message : cause != null ? String(cause) : "unknown";
    const resolvedDiagnostics =
      diagnostics ??
      buildSdkFailureDiagnostics("ENDPOINT_UNAVAILABLE", {
        stage: "network-dispatch",
        summary: "API network connection to endpoint failed.",
        remediation: "Verify endpoint URL and network connectivity; existing state was preserved.",
        retryable: true,
      });
    super(`API network error at '${path}': ${detail}`, undefined, true, resolvedDiagnostics);
    this.path = path;
    this.cause = cause;
  }
}

/**
 * A paginated response did not match the expected `{ items, nextCursor }`
 * shape, or its cursor would loop. Not retryable: the same request would
 * return the same malformed page.
 */
export class ApiPaginationError extends SorobanSdkError {
  public readonly path: string;

  constructor(path: string, reason: string, diagnostics?: readonly SdkDiagnostic[]) {
    const resolvedDiagnostics =
      diagnostics ??
      buildSdkFailureDiagnostics("VALIDATION_FAILED", {
        stage: "response-decoding",
        summary: "Paginated endpoint response schema validation failed.",
        remediation: "Check endpoint response schema or pagination parameters; existing state was preserved.",
        retryable: false,
      });
    super(`Malformed paginated response at '${path}': ${reason}`, undefined, false, resolvedDiagnostics);
    this.path = path;
  }
}

/** Non-OK HTTP response from the backend API. */
export class ApiHttpError extends SorobanSdkError {
  public readonly path: string;
  public readonly status: number;
  public readonly statusText: string;

  constructor(
    path: string,
    status: number,
    statusText: string,
    retryable: boolean,
    diagnostics?: readonly SdkDiagnostic[]
  ) {
    const isValidation = status >= 400 && status < 500 && status !== 408 && status !== 429;
    const defaultCode = isValidation ? "VALIDATION_FAILED" : "ENDPOINT_UNAVAILABLE";
    const defaultStage = isValidation ? "request-validation" : "network-dispatch";

    const resolvedDiagnostics =
      diagnostics ??
      buildSdkFailureDiagnostics(defaultCode, {
        stage: defaultStage,
        summary: `Endpoint returned HTTP status ${status}.`,
        remediation: isValidation
          ? "Check request parameters and resubmit; existing state and balances are unchanged."
          : "Retry the request with backoff; existing state was preserved.",
        retryable,
      });

    super(`API error (${status} ${statusText}) at ${path}`, undefined, retryable, resolvedDiagnostics);
    this.path = path;
    this.status = status;
    this.statusText = statusText;
  }
}

/** HTTP 429 from the backend API; `retryAfterMs` mirrors the `Retry-After` header when present. */
export class ApiRateLimitError extends ApiHttpError {
  public readonly retryAfterMs?: number;

  constructor(
    path: string,
    retryAfterMs?: number,
    statusText = "Too Many Requests",
    diagnostics?: readonly SdkDiagnostic[]
  ) {
    super(path, 429, statusText, true, diagnostics);
    this.retryAfterMs = retryAfterMs;
  }
}

/** HTTP 5xx from the backend API; treated as a transient, retryable failure. */
export class ApiServerError extends ApiHttpError {
  constructor(
    path: string,
    status: number,
    statusText: string,
    diagnostics?: readonly SdkDiagnostic[]
  ) {
    super(path, status, statusText, true, diagnostics);
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

export class DuplicateSubmissionError extends SorobanSdkError {
  public readonly operationId: string;
  public readonly status: "in_flight" | "committed";

  constructor(operationId: string, status: "in_flight" | "committed", message?: string) {
    super(
      message ||
        (status === "in_flight"
          ? `Signer submission for operation '${operationId}' is already in progress`
          : `Signer submission for operation '${operationId}' was already completed`),
      "sign",
      status === "in_flight"
    );
    this.operationId = operationId;
    this.status = status;
  }
}

export class SignerOperationConflictError extends SorobanSdkError {
  public readonly operationId: string;

  constructor(operationId: string, message?: string) {
    super(
      message ||
        `Operation identity conflict: operation '${operationId}' was previously submitted with different transaction parameters`,
      "sign",
      false
    );
    this.operationId = operationId;
  }
}

export class SignerValidationError extends SorobanSdkError {
  public readonly operationId?: string;

  constructor(message: string, operationId?: string) {
    super(`Signer validation failed: ${message}`, "sign", true);
    this.operationId = operationId;
  }
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
