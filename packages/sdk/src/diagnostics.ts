/**
 * Privacy-safe diagnostics for SDK endpoint configuration and lifecycle operations.
 *
 * When an endpoint configuration or request fails, callers need to know which stage
 * failed, why, and what remediation action to take — without exposing credentials,
 * RPC URLs with embedded tokens, wallet secret keys, addresses, or internal traces.
 *
 * Diagnostics are data-shaped rather than unstructured strings:
 *  - `code`         stable machine-readable identifier.
 *  - `stage`        the SDK or network stage reached when failure occurred.
 *  - `severity`     severity tier (info, warning, critical).
 *  - `summary`      concise operator-facing summary; never contains sensitive payloads.
 *  - `remediation`  the single next action, phrased as something to do.
 *  - `retryable`    whether repeating the same request is safe.
 *  - `privacySafe`  literal `true`, so consumers can assert the guarantee.
 */

/** SDK stage that produced (or failed to produce) a result. */
export type SdkStage =
  | "endpoint-configuration"
  | "request-validation"
  | "network-dispatch"
  | "response-decoding"
  | "simulate"
  | "sign"
  | "submit"
  | "poll"
  | "restore"
  | "state-persistence";

/** Stable, non-sensitive diagnostic identifiers. */
export type SdkDiagnosticCode =
  | "CONTEXT_INSUFFICIENT"
  | "VALIDATION_FAILED"
  | "ENDPOINT_UNAVAILABLE"
  | "STATE_PRESERVED"
  | "RETRY_UNSAFE"
  | "CONFIG_VERSION_CONFLICT";

export type SdkDiagnosticSeverity = "info" | "warning" | "critical";

export interface SdkDiagnostic {
  code: SdkDiagnosticCode;
  stage: SdkStage;
  severity: SdkDiagnosticSeverity;
  /** Short operator-facing sentence; contains no sensitive details. */
  summary: string;
  /** Next action, phrased as something to do. */
  remediation: string;
  /** Whether repeating the same request is safe. */
  retryable: boolean;
  /** Literal marker so consumers can assert the privacy guarantee. */
  privacySafe: true;
  /** Stable stage identifiers affected by the failure. */
  affectedStages?: SdkStage[];
}

export const SDK_STAGE_LABELS: Record<SdkStage, string> = {
  "endpoint-configuration": "Endpoint configuration",
  "request-validation": "Request validation",
  "network-dispatch": "Network dispatch",
  "response-decoding": "Response decoding",
  simulate: "Transaction simulation",
  sign: "Transaction signing",
  submit: "Network submission",
  poll: "Transaction confirmation",
  restore: "Footprint restoration",
  "state-persistence": "State persistence",
};

export function getSdkStageLabel(stage: SdkStage): string {
  return SDK_STAGE_LABELS[stage] ?? stage;
}

/**
 * Redact anything that could identify credentials, wallets, or internal paths
 * from free-form text before it is attached to an SDK diagnostic.
 */
export function redactDiagnosticText(
  value: string,
  fallback = "No additional detail."
): string {
  if (typeof value !== "string") return fallback;

  const redacted = value
    // Stack frames are never useful to an unauthenticated caller.
    .split(/\r?\n/)[0]
    // URLs with credentials or query parameters
    .replace(/\bhttps?:\/\/[^\s]+:[^\s]+@[^\s]+/gi, "[redacted-url-with-auth]")
    .replace(/\bhttps?:\/\/\S+/gi, "[redacted-url]")
    // Authorization headers & bearer tokens
    .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [redacted-token]")
    // Email addresses
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]")
    // Stellar public keys (G... or C...) and secret seeds (S...)
    .replace(/\b[GCS][A-Za-z0-9]{50,60}\b/g, "[redacted-address]")
    // Long hex blobs: transaction hashes, private keys, bearer tokens (32+ chars)
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted-hash]")
    // Windows file paths
    .replace(/[a-zA-Z]:\\[^\s]+/g, "[redacted-path]")
    // Unix file paths
    .replace(/(?:\/[\w.-]+){2,}/g, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();

  return redacted.length > 0 ? redacted.slice(0, 300) : fallback;
}

/** True when the text contains no URLs, secret keys, hashes, auth tokens, or filesystem paths. */
export function isPrivacySafeDiagnosticText(value: string): boolean {
  if (typeof value !== "string") return false;
  return !(
    /https?:\/\//i.test(value) ||
    /[\w.+-]+@[\w-]+\.[\w.-]+/.test(value) ||
    /\b[GCS][A-Za-z0-9]{50,60}\b/.test(value) ||
    /\b[a-f0-9]{32,}\b/i.test(value) ||
    /[a-zA-Z]:\\[^\s]+/.test(value) ||
    /(?:\/[\w.-]+){2,}/.test(value) ||
    /bearer\s+[a-zA-Z0-9._-]+/i.test(value)
  );
}

interface DiagnosticTemplate {
  severity: SdkDiagnosticSeverity;
  summary: string;
  remediation: string;
  retryable: boolean;
}

const TEMPLATES: Record<SdkDiagnosticCode, DiagnosticTemplate> = {
  CONTEXT_INSUFFICIENT: {
    severity: "warning",
    summary:
      "The endpoint response or execution context lacked sufficient diagnostic details to pinpoint the failure.",
    remediation:
      "Verify endpoint configuration and connectivity; existing state and account balances were preserved.",
    retryable: true,
  },
  VALIDATION_FAILED: {
    severity: "warning",
    summary:
      "The SDK endpoint configuration or request parameters failed validation before any network operation.",
    remediation:
      "Correct the flagged endpoint configuration or request parameters; existing state and balances are unchanged.",
    retryable: false,
  },
  ENDPOINT_UNAVAILABLE: {
    severity: "critical",
    summary:
      "The configured endpoint was unreachable or responded with an unrecoverable server failure.",
    remediation:
      "Retry the request using exponential backoff or fail over to a backup endpoint; existing state and balances are preserved.",
    retryable: true,
  },
  STATE_PRESERVED: {
    severity: "info",
    summary:
      "Existing client state, balances, and pending operations were preserved without modification.",
    remediation:
      "No state rollback is necessary; retry safely after verifying endpoint health.",
    retryable: true,
  },
  RETRY_UNSAFE: {
    severity: "warning",
    summary:
      "The operation may have reached the network or endpoint; repeating it blindly could result in duplicate state modification.",
    remediation:
      "Verify transaction status or endpoint state before retrying. Existing local state was preserved.",
    retryable: false,
  },
  CONFIG_VERSION_CONFLICT: {
    severity: "warning",
    summary:
      "Endpoint configuration changed concurrently, so the conditional update was rejected before any state was persisted.",
    remediation:
      "Reload the current endpoint configuration version and retry the update; existing state and balances were preserved.",
    retryable: true,
  },
};

export interface BuildSdkDiagnosticOptions {
  stage: SdkStage;
  /** Optional stable stage list; raw values are never accepted here. */
  affectedStages?: SdkStage[];
  /** Overrides the template severity. */
  severity?: SdkDiagnosticSeverity;
  /** Optional custom summary; will be sanitized through redactDiagnosticText. */
  summary?: string;
  /** Optional custom remediation; will be sanitized through redactDiagnosticText. */
  remediation?: string;
  /** Overrides whether the same request may be retried. */
  retryable?: boolean;
}

/**
 * Build a canonical privacy-safe SDK diagnostic.
 */
export function buildSdkDiagnostic(
  code: SdkDiagnosticCode,
  options: BuildSdkDiagnosticOptions
): SdkDiagnostic {
  const template = TEMPLATES[code];
  const affectedStages = options.affectedStages
    ? [...new Set(options.affectedStages)]
    : undefined;

  const rawSummary = options.summary ?? template.summary;
  const rawRemediation = options.remediation ?? template.remediation;

  const summary = redactDiagnosticText(rawSummary);
  const remediation = redactDiagnosticText(rawRemediation);

  return {
    code,
    stage: options.stage,
    severity: options.severity ?? template.severity,
    summary,
    remediation,
    retryable: options.retryable ?? template.retryable,
    privacySafe: true,
    ...(affectedStages && affectedStages.length > 0 ? { affectedStages } : {}),
  };
}

export interface BuildSdkFailureOptions extends BuildSdkDiagnosticOptions {
  /**
   * Attach a `STATE_PRESERVED` diagnostic after the primary failure. Defaults
   * to `true`: SDK validation and transient failure paths preserve existing state
   * and balances.
   */
  preserveState?: boolean;
}

/**
 * Build the diagnostics for a failed SDK stage: the primary failure first,
 * followed by an explicit statement that prior state and balances were preserved.
 */
export function buildSdkFailureDiagnostics(
  code: SdkDiagnosticCode,
  options: BuildSdkFailureOptions
): SdkDiagnostic[] {
  const primary = buildSdkDiagnostic(code, options);
  const diagnostics: SdkDiagnostic[] = [primary];

  if (options.preserveState !== false) {
    diagnostics.push(
      buildSdkDiagnostic("STATE_PRESERVED", {
        stage: "state-persistence",
        affectedStages: [options.stage],
      })
    );
  }

  return diagnostics;
}

/** True when every diagnostic carries the privacySafe marker and privacy-safe text. */
export function areDiagnosticsPrivacySafe(
  diagnostics: ReadonlyArray<Pick<SdkDiagnostic, "privacySafe" | "summary" | "remediation">>
): boolean {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return true;
  return diagnostics.every(
    (diagnostic) =>
      diagnostic.privacySafe === true &&
      isPrivacySafeDiagnosticText(diagnostic.summary) &&
      isPrivacySafeDiagnosticText(diagnostic.remediation)
  );
}
