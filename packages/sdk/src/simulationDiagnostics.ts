/**
 * Privacy-safe diagnostics for the SDK's simulation path.
 *
 * Preparing a state-changing vault operation runs several stages (amount
 * validation, transaction build, simulation, result decoding). Contract
 * simulation failures sometimes arrive with very little usable context: no
 * decodable `Error(Contract, #N)` code and no diagnostic events. Callers still
 * need to know *which stage* failed and *what to do next* without the SDK
 * echoing raw RPC URLs, wallet addresses, transaction XDR, upstream error text,
 * or stack traces.
 *
 * Diagnostics here are data-shaped rather than message-shaped:
 *  - `code`         stable machine-readable identifier, safe to alert on.
 *  - `stage`        the simulation stage that was reached but not completed.
 *  - `summary`      one sentence a caller can read; never raw error output.
 *  - `remediation`  the next action, phrased as something to do.
 *  - `retryable`    whether repeating the same prepare call is safe.
 *  - `privacySafe`  literal `true`, so consumers can assert the guarantee.
 *
 * The text comes from fixed templates. Runtime error strings are never placed
 * into a diagnostic, so an invalid amount, an RPC outage, and an unreachable
 * endpoint all produce output that is safe to log or surface to a user.
 */

/** Stage of a simulation prepare call that produced (or failed to produce) a result. */
export type SimulationStage =
  | "input-validation"
  | "transaction-build"
  | "simulation"
  | "result-decoding"
  | "restore"
  | "state-persistence";

/** Stable, non-sensitive diagnostic identifiers. */
export type SimulationDiagnosticCode =
  | "CONTEXT_INSUFFICIENT"
  | "VALIDATION_FAILED"
  | "SIMULATION_FAILED"
  | "RESULT_DECODE_FAILED"
  | "RESTORE_REQUIRED"
  | "STATE_PRESERVED"
  | "RETRY_UNSAFE";

/** Codes that may open a failure diagnostic list. */
export type SimulationFailureCode = Exclude<SimulationDiagnosticCode, "STATE_PRESERVED">;

export type SimulationDiagnosticSeverity = "info" | "warning" | "critical";

export interface SimulationDiagnostic {
  code: SimulationDiagnosticCode;
  stage: SimulationStage;
  severity: SimulationDiagnosticSeverity;
  /** Short caller-facing sentence; contains no raw error payload. */
  summary: string;
  /** Next action, phrased as something to do. */
  remediation: string;
  /** Whether repeating the same prepare call is safe. */
  retryable: boolean;
  /** Literal marker so consumers can assert the privacy guarantee. */
  privacySafe: true;
  /**
   * Stable stage identifiers (for example `"simulation"`), never raw values.
   * Lets callers group diagnostics without parsing the summary.
   */
  affectedStages?: SimulationStage[];
}

export const SIMULATION_STAGE_LABELS: Record<SimulationStage, string> = {
  "input-validation": "Input validation",
  "transaction-build": "Transaction build",
  simulation: "Contract simulation",
  "result-decoding": "Simulation result decoding",
  restore: "Ledger entry restore",
  "state-persistence": "State persistence",
};

export function getSimulationStageLabel(stage: SimulationStage): string {
  return SIMULATION_STAGE_LABELS[stage];
}

/**
 * Redact anything that could identify a user, a wallet, or infrastructure from
 * free-form text before it is attached to a diagnostic.
 *
 * Diagnostics use fixed templates and should not pass raw text at all; this is
 * defence in depth for callers that build custom diagnostics.
 */
export function redactSimulationDiagnosticText(
  value: string,
  fallback = "No additional detail."
): string {
  if (typeof value !== "string") return fallback;

  const redacted = value
    // Stack frames are never useful to a caller.
    .split(/\r?\n/)[0]
    // URLs and RPC endpoints.
    .replace(/\bhttps?:\/\/\S+/gi, "[redacted-url]")
    // Email addresses.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]")
    // Stellar public keys and secret seeds (G.../S... base32, 56 chars).
    .replace(/\b[GS][A-Z2-7]{55}\b/g, "[redacted-address]")
    // Long hex blobs: tx hashes, private keys, bearer tokens.
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted-hash]")
    // Filesystem paths.
    .replace(/(?:\/[\w.-]+){2,}/g, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();

  return redacted.length > 0 ? redacted.slice(0, 200) : fallback;
}

/** True when the text no longer contains a URL, address, hash, or path. */
export function isPrivacySafeSimulationText(value: string): boolean {
  if (typeof value !== "string") return false;
  return !(
    /https?:\/\//i.test(value) ||
    /[\w.+-]+@[\w-]+\.[\w.-]+/.test(value) ||
    /\b[GS][A-Z2-7]{55}\b/.test(value) ||
    /\b[a-f0-9]{32,}\b/i.test(value) ||
    /(?:\/[\w.-]+){2,}/.test(value)
  );
}

export interface SimulationDiagnosticContext {
  /** Number of diagnostic events attached to the failed simulation. */
  diagnosticEventCount: number;
  /** True when the failure carried any error text at all. */
  hasErrorMessage: boolean;
  /** Decoded contract error code, when one was available. */
  contractErrorCode?: number;
}

/**
 * Context captured from a failed simulation. It contains counts and a decoded
 * contract error code only — never the raw error message, XDR, addresses, or
 * endpoints — so it can be attached to an error safely.
 */
export interface SimulationFailureInput {
  /** Raw caught value. Read only for structure/code; never echoed. */
  error: unknown;
  /** Contract method whose prepare call failed (a fixed SDK identifier). */
  method?: string;
  /** Explicit context when the caller already inspected a simulation response. */
  context?: Partial<SimulationDiagnosticContext>;
}

interface DiagnosticTemplate {
  severity: SimulationDiagnosticSeverity;
  summary: string;
  remediation: string;
  retryable: boolean;
}

const TEMPLATES: Record<SimulationDiagnosticCode, DiagnosticTemplate> = {
  CONTEXT_INSUFFICIENT: {
    severity: "warning",
    summary:
      "Contract simulation failed without enough diagnostic detail to identify a specific contract error.",
    remediation:
      "Retry the simulation once; if it still fails, confirm the RPC endpoint is reachable and re-run with a fresh source-account sequence number. No transaction was signed or submitted.",
    retryable: true,
  },
  VALIDATION_FAILED: {
    severity: "warning",
    summary:
      "The request was rejected during input validation, before a transaction was built or simulated.",
    remediation:
      "Correct the flagged arguments and retry; no transaction was built, signed, or submitted and no vault state changed.",
    retryable: false,
  },
  SIMULATION_FAILED: {
    severity: "critical",
    summary:
      "The contract rejected the simulated transaction, so its result cannot be trusted.",
    remediation:
      "Resolve the contract error reported by the simulation (for example amount, authorization, pause, or slippage) and retry. No transaction was signed or submitted.",
    retryable: false,
  },
  RESULT_DECODE_FAILED: {
    severity: "warning",
    summary:
      "The simulation completed but its result could not be decoded with the pinned contract bindings.",
    remediation:
      "Confirm the configured contract spec hash matches the deployed contract, then retry. No transaction was signed or submitted.",
    retryable: false,
  },
  RESTORE_REQUIRED: {
    severity: "info",
    summary:
      "The simulation found expired ledger entries that must be restored before the operation can proceed.",
    remediation:
      "Pass the restore preamble to restoreAndRetry(), wait for confirmation, then retry the original prepare call. No vault state changed.",
    retryable: true,
  },
  STATE_PRESERVED: {
    severity: "info",
    summary:
      "Existing vault state, balances, and transactions were left unchanged by the failed simulation.",
    remediation:
      "No recovery action is needed; retry only after the failed stage has been addressed.",
    retryable: true,
  },
  RETRY_UNSAFE: {
    severity: "warning",
    summary:
      "The operation failed after it may have reached the network, so repeating it blindly could submit twice.",
    remediation:
      "Check the transaction hash or vault state before retrying. Existing balances were not changed by the SDK.",
    retryable: false,
  },
};

export interface BuildSimulationDiagnosticOptions {
  stage: SimulationStage;
  /** Optional stable stage list; raw values are never accepted here. */
  affectedStages?: SimulationStage[];
  /** Overrides the template severity (for example degraded vs failed stage). */
  severity?: SimulationDiagnosticSeverity;
  /** Overrides whether the same prepare call may be retried. */
  retryable?: boolean;
}

/**
 * Build a canonical diagnostic. The text comes from a fixed template, so this
 * is the only supported way to attach meaning to a simulation failure.
 */
export function buildSimulationDiagnostic(
  code: SimulationDiagnosticCode,
  options: BuildSimulationDiagnosticOptions
): SimulationDiagnostic {
  const template = TEMPLATES[code];
  const affectedStages = options.affectedStages
    ? [...new Set(options.affectedStages)]
    : undefined;

  return {
    code,
    stage: options.stage,
    severity: options.severity ?? template.severity,
    summary: template.summary,
    remediation: template.remediation,
    retryable: options.retryable ?? template.retryable,
    privacySafe: true,
    ...(affectedStages && affectedStages.length > 0 ? { affectedStages } : {}),
  };
}

export interface BuildSimulationFailureOptions extends BuildSimulationDiagnosticOptions {
  /**
   * Attach a `STATE_PRESERVED` diagnostic after the primary failure. Defaults
   * to `true`: every simulation failure path in this SDK is read-only, so
   * existing balances and vault state are never modified.
   */
  preserveState?: boolean;
}

/**
 * Build the diagnostics for a failed simulation stage: the primary failure
 * first, followed by an explicit statement that prior state was preserved.
 */
export function buildSimulationFailureDiagnostics(
  code: SimulationFailureCode,
  options: BuildSimulationFailureOptions
): SimulationDiagnostic[] {
  const diagnostics = [buildSimulationDiagnostic(code, options)];

  if (options.preserveState !== false) {
    diagnostics.push(
      buildSimulationDiagnostic("STATE_PRESERVED", {
        stage: "state-persistence",
        affectedStages: [options.stage],
      })
    );
  }

  return diagnostics;
}

/** True when every diagnostic carries the privacy-safe marker and safe text. */
export function areSimulationDiagnosticsPrivacySafe(
  diagnostics: ReadonlyArray<
    Pick<SimulationDiagnostic, "privacySafe" | "summary" | "remediation">
  >
): boolean {
  return diagnostics.every(
    (diagnostic) =>
      diagnostic.privacySafe === true &&
      isPrivacySafeSimulationText(diagnostic.summary) &&
      isPrivacySafeSimulationText(diagnostic.remediation)
  );
}

const CONTRACT_ERROR_PATTERN =
  /(?:Error\(Contract,\s*#(\d+)\)|ErrorCode\((\d+)\)|(?:Contract\s*)?Error\s*#?(\d+))/i;

/** Extract a decodable contract error code from an unknown caught value. */
export function extractContractErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    const match = CONTRACT_ERROR_PATTERN.exec(String(error));
    return match ? parseInt(match[1] || match[2] || match[3], 10) : undefined;
  }

  const candidate = error as {
    errorCode?: unknown;
    message?: unknown;
    error?: unknown;
  };
  if (
    typeof candidate.errorCode === "number" &&
    Number.isFinite(candidate.errorCode) &&
    candidate.errorCode !== 999
  ) {
    return candidate.errorCode;
  }

  for (const text of [candidate.message, candidate.error]) {
    if (typeof text !== "string") continue;
    const match = CONTRACT_ERROR_PATTERN.exec(text);
    if (match) return parseInt(match[1] || match[2] || match[3], 10);
  }
  return undefined;
}

/** Count diagnostic events from the common error/simulation response shapes. */
export function extractDiagnosticEventCount(error: unknown): number {
  if (typeof error !== "object" || error === null) return 0;
  const candidate = error as Record<string, any>;

  const direct = candidate.diagnosticEvents;
  if (Array.isArray(direct)) return direct.length;

  const simulation = candidate.simulation;
  if (simulation && typeof simulation === "object") {
    if (Array.isArray(simulation.diagnosticEvents)) return simulation.diagnosticEvents.length;
    if (Array.isArray(simulation.events)) return simulation.events.length;
  }

  if (Array.isArray(candidate.events)) return candidate.events.length;
  return 0;
}

/**
 * Capture privacy-safe context about a failed simulation. Only counts and a
 * decoded contract error code are returned.
 */
export function captureSimulationContext(
  error: unknown,
  context: Partial<SimulationDiagnosticContext> = {}
): SimulationDiagnosticContext {
  const errorCode = context.contractErrorCode ?? extractContractErrorCode(error);
  const message =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown }).message
      : error;

  return {
    diagnosticEventCount:
      context.diagnosticEventCount ?? extractDiagnosticEventCount(error),
    hasErrorMessage:
      context.hasErrorMessage ??
      (typeof message === "string" ? message.trim().length > 0 : message != null),
    ...(errorCode !== undefined ? { contractErrorCode: errorCode } : {}),
  };
}

/**
 * True when a failure carries enough context to name a specific contract
 * error. A decodable error code or at least one diagnostic event counts.
 */
export function hasSufficientDiagnosticContext(
  context: Pick<SimulationDiagnosticContext, "diagnosticEventCount" | "contractErrorCode">
): boolean {
  return context.contractErrorCode !== undefined || context.diagnosticEventCount > 0;
}

export interface ClassifiedSimulationFailure {
  code: SimulationFailureCode;
  stage: SimulationStage;
  context: SimulationDiagnosticContext;
}

/**
 * Classify a caught simulation failure without propagating raw error text.
 *
 * - A decodable contract error code means the simulation produced a specific
 *   contract rejection (`SIMULATION_FAILED`).
 * - Diagnostic events without a decoded code still mean the contract ran, so
 *   the failure is `SIMULATION_FAILED` rather than context-less.
 * - No code and no events means there is insufficient diagnostic context
 *   (`CONTEXT_INSUFFICIENT`) and a bounded retry is the safe next step.
 */
export function classifySimulationFailure(
  input: SimulationFailureInput
): ClassifiedSimulationFailure {
  const context = captureSimulationContext(input.error, input.context);
  const code: SimulationFailureCode = hasSufficientDiagnosticContext(context)
    ? "SIMULATION_FAILED"
    : "CONTEXT_INSUFFICIENT";

  return { code, stage: "simulation", context };
}
