/**
 * Privacy-safe diagnostics for transparency status surfaces.
 *
 * The transparency dashboard combines several independent signals (indexer,
 * relayer, registry, smoke test, metric aggregation). When one of those signals
 * is missing, malformed, or throws, the operator needs to know *which stage*
 * failed and *what to do next* — without the API echoing raw error text, RPC
 * URLs, wallets, or stack traces back to every visitor.
 *
 * Diagnostics here are deliberately data-shaped rather than message-shaped:
 *  - `code`         stable machine-readable identifier, safe to alert on.
 *  - `stage`        the pipeline stage that was reached but not completed.
 *  - `summary`      one sentence an operator can read; never raw error output.
 *  - `remediation`  the next action, phrased as something to do.
 *  - `retryable`    whether re-running the same read is safe (it always is for
 *                   these read-only transparency stages, but callers should not
 *                   have to assume).
 *  - `privacySafe`  literal `true`, so consumers can assert the guarantee.
 *
 * The same module is imported by both the server route and the client status
 * rollup, so a failed stage is named identically on both sides.
 */

/** Pipeline stage that produced (or failed to produce) transparency status. */
export type TransparencyStage =
  | "context-validation"
  | "indexer"
  | "relayer"
  | "registry"
  | "smoke-test"
  | "aggregation"
  | "cache";

/** Stable, non-sensitive diagnostic identifiers. */
export type TransparencyDiagnosticCode =
  | "CONTEXT_INSUFFICIENT"
  | "SUBSYSTEM_UNAVAILABLE"
  | "STALE_LAST_KNOWN"
  | "AGGREGATION_FAILED"
  | "NO_DATA_AVAILABLE";

export type TransparencyDiagnosticSeverity = "info" | "warning" | "critical";

export interface TransparencyDiagnostic {
  code: TransparencyDiagnosticCode;
  stage: TransparencyStage;
  severity: TransparencyDiagnosticSeverity;
  /** Short operator-facing sentence; contains no raw error payload. */
  summary: string;
  /** Next action, phrased as something to do. */
  remediation: string;
  /** Whether re-reading the same status is safe once the stage recovers. */
  retryable: boolean;
  /** Literal marker so consumers can assert the privacy guarantee. */
  privacySafe: true;
  /**
   * Stable stage/subsystem identifiers (for example `"indexer"`), never raw
   * values. Lets the UI group diagnostics without parsing the summary.
   */
  affectedStages?: TransparencyStage[];
}

export const TRANSPARENCY_STAGE_LABELS: Record<TransparencyStage, string> = {
  "context-validation": "Diagnostic context",
  indexer: "Indexer",
  relayer: "Relayer",
  registry: "Registry",
  "smoke-test": "Smoke test",
  aggregation: "Metric aggregation",
  cache: "Cached snapshot",
};

export function getTransparencyStageLabel(stage: TransparencyStage): string {
  return TRANSPARENCY_STAGE_LABELS[stage];
}

/**
 * Redact anything that could identify a user, a wallet, or infrastructure from
 * free-form diagnostic text before it is attached to an API response.
 *
 * This is a defence in depth measure: callers should not pass raw error text in
 * the first place, but if they do, the result still must not leak.
 */
export function redactDiagnosticText(value: string, fallback = "No additional detail."): string {
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
export function isPrivacySafeDiagnosticText(value: string): boolean {
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
  severity: TransparencyDiagnosticSeverity;
  summary: string;
  remediation: string;
  retryable: boolean;
}

const TEMPLATES: Record<TransparencyDiagnosticCode, DiagnosticTemplate> = {
  CONTEXT_INSUFFICIENT: {
    severity: "warning",
    summary:
      "Transparency status is based on partial diagnostic context, so the overall rollup cannot be confirmed.",
    remediation:
      "Keep the last known status visible and retry once the missing subsystems report; no cached metrics or balances were modified.",
    retryable: true,
  },
  SUBSYSTEM_UNAVAILABLE: {
    severity: "warning",
    summary: "A transparency subsystem did not report a usable status.",
    remediation:
      "Check that subsystem's health endpoint, then retry the status read. Previously reported signals are retained.",
    retryable: true,
  },
  STALE_LAST_KNOWN: {
    severity: "info",
    summary: "Serving the last known-good transparency signal for a subsystem that is currently unavailable.",
    remediation:
      "Treat this value as stale and retry the status read once the subsystem recovers.",
    retryable: true,
  },
  AGGREGATION_FAILED: {
    severity: "critical",
    summary: "Transparency metrics could not be aggregated from the upstream sources.",
    remediation:
      "Retry the request after the next aggregation window (60s); if it persists, inspect the aggregation stage in server logs. The cached snapshot was preserved.",
    retryable: true,
  },
  NO_DATA_AVAILABLE: {
    severity: "critical",
    summary: "No transparency snapshot is available yet, so no metrics can be shown.",
    remediation:
      "Retry once the aggregation stage succeeds. There is no previous snapshot to fall back to.",
    retryable: true,
  },
};

export interface BuildTransparencyDiagnosticOptions {
  stage: TransparencyStage;
  /** Optional stable stage list; raw values are never accepted here. */
  affectedStages?: TransparencyStage[];
  /** Overrides the template severity (for example degraded vs failed subsystem). */
  severity?: TransparencyDiagnosticSeverity;
  /** Optional additional detail; always redacted before being returned. */
  detail?: string;
}

/**
 * Build a canonical diagnostic. Any `detail` supplied is redacted, so this is
 * the only supported way to attach free-form text to a diagnostic.
 */
export function buildTransparencyDiagnostic(
  code: TransparencyDiagnosticCode,
  options: BuildTransparencyDiagnosticOptions,
): TransparencyDiagnostic {
  const template = TEMPLATES[code];
  return {
    code,
    stage: options.stage,
    severity: options.severity ?? template.severity,
    summary: template.summary,
    remediation: template.remediation,
    retryable: template.retryable,
    privacySafe: true,
    ...(options.affectedStages && options.affectedStages.length > 0
      ? { affectedStages: [...new Set(options.affectedStages)] }
      : {}),
  };
}

/** True when every diagnostic carries the privacy-safe marker. */
export function areDiagnosticsPrivacySafe(
  diagnostics: ReadonlyArray<Pick<TransparencyDiagnostic, "privacySafe" | "summary" | "remediation">>,
): boolean {
  return diagnostics.every(
    (diagnostic) =>
      diagnostic.privacySafe === true &&
      isPrivacySafeDiagnosticText(diagnostic.summary) &&
      isPrivacySafeDiagnosticText(diagnostic.remediation),
  );
}
