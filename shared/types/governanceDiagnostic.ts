/**
 * Privacy-safe diagnostics for governance surfaces.
 *
 * A governance action moves through several stages (request validation,
 * forecasting, quorum evaluation, attachment validation, transaction build,
 * wallet signing, network submission, confirmation). When one of those stages
 * fails, the caller needs to know *which stage* was reached and *what to do
 * next* — without the API echoing raw error text, transaction XDR, wallet
 * addresses, RPC URLs, or stack traces back to every viewer.
 *
 * Diagnostics here are deliberately data-shaped rather than message-shaped:
 *  - `code`         stable machine-readable identifier, safe to alert on.
 *  - `stage`        the governance stage that was reached but not completed.
 *  - `summary`      one sentence an operator can read; never raw error output.
 *  - `remediation`  the next action, phrased as something to do.
 *  - `retryable`    whether repeating the same request is safe.
 *  - `privacySafe`  literal `true`, so consumers can assert the guarantee.
 *
 * The same module is imported by the server routes and the client governance
 * UI, so a failed stage is named identically on both sides.
 */

/** Governance stage that produced (or failed to produce) a result. */
export type GovernanceStage =
  | "request-validation"
  | "forecast"
  | "quorum"
  | "attachments"
  | "proposal-build"
  | "wallet-signing"
  | "submission"
  | "confirmation"
  | "state-persistence";

/** Stable, non-sensitive diagnostic identifiers. */
export type GovernanceDiagnosticCode =
  | "CONTEXT_INSUFFICIENT"
  | "VALIDATION_FAILED"
  | "STAGE_UNAVAILABLE"
  | "STATE_PRESERVED"
  | "RETRY_UNSAFE";

export type GovernanceDiagnosticSeverity = "info" | "warning" | "critical";

export interface GovernanceDiagnostic {
  code: GovernanceDiagnosticCode;
  stage: GovernanceStage;
  severity: GovernanceDiagnosticSeverity;
  /** Short operator-facing sentence; contains no raw error payload. */
  summary: string;
  /** Next action, phrased as something to do. */
  remediation: string;
  /** Whether repeating the same request is safe. */
  retryable: boolean;
  /** Literal marker so consumers can assert the privacy guarantee. */
  privacySafe: true;
  /**
   * Stable stage identifiers (for example `"proposal-build"`), never raw
   * values. Lets the UI group diagnostics without parsing the summary.
   */
  affectedStages?: GovernanceStage[];
}

export const GOVERNANCE_STAGE_LABELS: Record<GovernanceStage, string> = {
  "request-validation": "Request validation",
  forecast: "Impact forecast",
  quorum: "Signer quorum",
  attachments: "Proposal attachments",
  "proposal-build": "Proposal transaction build",
  "wallet-signing": "Wallet signing",
  submission: "Network submission",
  confirmation: "Network confirmation",
  "state-persistence": "State persistence",
};

export function getGovernanceStageLabel(stage: GovernanceStage): string {
  return GOVERNANCE_STAGE_LABELS[stage];
}

/**
 * Redact anything that could identify a user, a wallet, or infrastructure from
 * free-form diagnostic text before it is attached to an API response.
 *
 * This is a defence in depth measure: callers should not pass raw error text in
 * the first place, but if they do, the result still must not leak.
 */
export function redactGovernanceDiagnosticText(
  value: string,
  fallback = "No additional detail.",
): string {
  if (typeof value !== "string") return fallback;

  const redacted = value
    // Stack frames are never useful to an unauthenticated caller.
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
export function isPrivacySafeGovernanceText(value: string): boolean {
  if (typeof value !== "string") return false;
  return !(
    /https?:\/\//i.test(value) ||
    /[\w.+-]+@[\w-]+\.[\w.-]+/.test(value) ||
    /\b[GS][A-Z2-7]{55}\b/.test(value) ||
    /\b[a-f0-9]{32,}\b/i.test(value) ||
    /(?:\/[\w.-]+){2,}/.test(value)
  );
}

interface DiagnosticTemplate {
  severity: GovernanceDiagnosticSeverity;
  summary: string;
  remediation: string;
  retryable: boolean;
}

const TEMPLATES: Record<GovernanceDiagnosticCode, DiagnosticTemplate> = {
  CONTEXT_INSUFFICIENT: {
    severity: "warning",
    summary:
      "The governance request did not carry enough context to identify which proposal stage failed.",
    remediation:
      "Resubmit with the proposal and stage identified; no proposal, signature, or balance state was modified.",
    retryable: false,
  },
  VALIDATION_FAILED: {
    severity: "warning",
    summary:
      "The governance request was rejected during validation, before any state-changing step.",
    remediation:
      "Correct the flagged fields and resubmit; existing proposals, signatures, and balances are unchanged.",
    retryable: false,
  },
  STAGE_UNAVAILABLE: {
    severity: "critical",
    summary: "A governance stage could not complete, so its result cannot be trusted.",
    remediation:
      "Retry the same request once; if the stage still fails, check server logs for that stage. Existing proposal state was preserved.",
    retryable: true,
  },
  STATE_PRESERVED: {
    severity: "info",
    summary:
      "Existing proposal, signature, and balance state was left unchanged by the failed request.",
    remediation:
      "No recovery action is needed; retry only when the failed stage is healthy again.",
    retryable: true,
  },
  RETRY_UNSAFE: {
    severity: "warning",
    summary:
      "The request failed after it may have reached the network, so repeating it blindly could submit the proposal twice.",
    remediation:
      "Check the transaction hash or proposal status before retrying. Existing proposal state was preserved.",
    retryable: false,
  },
};

export interface BuildGovernanceDiagnosticOptions {
  stage: GovernanceStage;
  /** Optional stable stage list; raw values are never accepted here. */
  affectedStages?: GovernanceStage[];
  /** Overrides the template severity (for example degraded vs failed stage). */
  severity?: GovernanceDiagnosticSeverity;
  /** Overrides whether the same request may be retried. */
  retryable?: boolean;
}

/**
 * Build a canonical diagnostic. The text comes from a fixed template, so this
 * is the only supported way to attach meaning to a governance failure.
 */
export function buildGovernanceDiagnostic(
  code: GovernanceDiagnosticCode,
  options: BuildGovernanceDiagnosticOptions,
): GovernanceDiagnostic {
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

export interface BuildGovernanceFailureOptions extends BuildGovernanceDiagnosticOptions {
  /**
   * Attach a `STATE_PRESERVED` diagnostic after the primary failure. Defaults
   * to `true`: every governance failure path in this codebase is designed to
   * leave existing proposals, signatures, and balances untouched.
   */
  preserveState?: boolean;
}

/**
 * Build the diagnostics for a failed governance stage: the primary failure
 * first, followed by an explicit statement that prior state was preserved.
 */
export function buildGovernanceFailureDiagnostics(
  code: GovernanceDiagnosticCode,
  options: BuildGovernanceFailureOptions,
): GovernanceDiagnostic[] {
  const primary = buildGovernanceDiagnostic(code, options);
  const diagnostics = [primary];

  if (options.preserveState !== false) {
    diagnostics.push(
      buildGovernanceDiagnostic("STATE_PRESERVED", {
        stage: "state-persistence",
        affectedStages: [options.stage],
      }),
    );
  }

  return diagnostics;
}

/** True when every diagnostic carries the privacy-safe marker and safe text. */
export function areGovernanceDiagnosticsPrivacySafe(
  diagnostics: ReadonlyArray<
    Pick<GovernanceDiagnostic, "privacySafe" | "summary" | "remediation">
  >,
): boolean {
  return diagnostics.every(
    (diagnostic) =>
      diagnostic.privacySafe === true &&
      isPrivacySafeGovernanceText(diagnostic.summary) &&
      isPrivacySafeGovernanceText(diagnostic.remediation),
  );
}
