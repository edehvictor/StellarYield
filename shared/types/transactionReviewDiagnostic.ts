/**
 * Privacy-safe diagnostics for the transaction review flow (#1893).
 *
 * A zap deposit review moves through several stages: request validation, quote
 * generation, quote verification, wallet signing, network submission and
 * confirmation. When a stage fails, callers previously received a bare error
 * string (and, for 500s, the raw exception message), so they could not tell
 * which stage failed, what to do next, or whether retrying was safe.
 *
 * Diagnostics are data-shaped, built only from fixed templates, and never echo
 * raw error text, wallet addresses, XDR, RPC URLs or stack traces. The same
 * module is used by the server routes and the client review modal.
 *
 * Every failure in this flow is read-only: no balances, quotes or signed
 * transactions are mutated by a failed review, and `STATE_PRESERVED` says so.
 */

export type TransactionReviewStage =
  | "request-validation"
  | "quote"
  | "quote-verification"
  | "wallet-signing"
  | "submission"
  | "confirmation"
  | "state-persistence"
  /** The failing stage could not be determined from the available context. */
  | "unknown";

export type TransactionReviewDiagnosticCode =
  | "CONTEXT_INSUFFICIENT"
  | "VALIDATION_FAILED"
  | "STAGE_UNAVAILABLE"
  | "QUOTE_REFRESH_REQUIRED"
  | "STATE_PRESERVED"
  | "RETRY_UNSAFE";

export type TransactionReviewDiagnosticSeverity = "info" | "warning" | "critical";

export interface TransactionReviewDiagnostic {
  code: TransactionReviewDiagnosticCode;
  stage: TransactionReviewStage;
  severity: TransactionReviewDiagnosticSeverity;
  /** Fixed-template sentence; never contains raw error output. */
  summary: string;
  /** Next action, phrased as something to do. */
  remediation: string;
  /** Whether repeating the same request is safe. */
  retryable: boolean;
  /** Literal marker so consumers can assert the privacy guarantee. */
  privacySafe: true;
  affectedStages?: TransactionReviewStage[];
}

export const TRANSACTION_REVIEW_STAGE_LABELS: Record<TransactionReviewStage, string> = {
  "request-validation": "Request validation",
  quote: "Quote generation",
  "quote-verification": "Quote verification",
  "wallet-signing": "Wallet signing",
  submission: "Network submission",
  confirmation: "Network confirmation",
  "state-persistence": "State persistence",
  unknown: "Unidentified stage",
};

export function getTransactionReviewStageLabel(stage: TransactionReviewStage): string {
  return TRANSACTION_REVIEW_STAGE_LABELS[stage] ?? TRANSACTION_REVIEW_STAGE_LABELS.unknown;
}

interface Template {
  severity: TransactionReviewDiagnosticSeverity;
  summary: string;
  remediation: string;
  retryable: boolean;
}

const TEMPLATES: Record<TransactionReviewDiagnosticCode, Template> = {
  CONTEXT_INSUFFICIENT: {
    severity: "warning",
    summary:
      "The review failed, but there was not enough context to identify which stage stopped.",
    remediation:
      "Refresh the quote and review again. If it keeps failing, report the request id; nothing was signed or submitted.",
    retryable: true,
  },
  VALIDATION_FAILED: {
    severity: "warning",
    summary: "The review request was rejected during validation, before any quote or signing step.",
    remediation:
      "Correct the amount or token fields and review again; balances and existing quotes are unchanged.",
    retryable: false,
  },
  STAGE_UNAVAILABLE: {
    severity: "critical",
    summary: "A review stage could not complete, so its result cannot be trusted.",
    remediation:
      "Retry once; if the stage still fails, wait and try again later. Nothing was signed or submitted.",
    retryable: true,
  },
  QUOTE_REFRESH_REQUIRED: {
    severity: "warning",
    summary: "The quote no longer matches current conditions and was not accepted.",
    remediation: "Request a fresh quote and review it again; the old quote cannot be reused.",
    retryable: true,
  },
  STATE_PRESERVED: {
    severity: "info",
    summary: "Balances, quotes and signed transactions were left unchanged by the failed review.",
    remediation: "No recovery action is needed; retry when the failed stage is healthy again.",
    retryable: true,
  },
  RETRY_UNSAFE: {
    severity: "warning",
    summary:
      "The failure happened after the transaction may have reached the network, so repeating it blindly could deposit twice.",
    remediation:
      "Check the transaction status in your wallet or an explorer before retrying.",
    retryable: false,
  },
};

export interface BuildTransactionReviewDiagnosticOptions {
  stage: TransactionReviewStage;
  affectedStages?: TransactionReviewStage[];
  severity?: TransactionReviewDiagnosticSeverity;
  retryable?: boolean;
}

export function buildTransactionReviewDiagnostic(
  code: TransactionReviewDiagnosticCode,
  options: BuildTransactionReviewDiagnosticOptions,
): TransactionReviewDiagnostic {
  const template = TEMPLATES[code];
  const affectedStages = options.affectedStages ? [...new Set(options.affectedStages)] : undefined;
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

/**
 * Primary failure diagnostic followed by an explicit `STATE_PRESERVED` entry.
 * Review failures never mutate state, so the second entry is always accurate.
 */
export function buildTransactionReviewFailureDiagnostics(
  code: TransactionReviewDiagnosticCode,
  options: BuildTransactionReviewDiagnosticOptions,
): TransactionReviewDiagnostic[] {
  return [
    buildTransactionReviewDiagnostic(code, options),
    buildTransactionReviewDiagnostic("STATE_PRESERVED", {
      stage: "state-persistence",
      affectedStages: [options.stage],
    }),
  ];
}

/**
 * Map a failed `/api/zap/verify` error code to diagnostics. Stale or untrusted
 * quote/review configuration snapshots (expiry, asset-config drift, or missing/
 * mismatched assumption fingerprints) require a fresh quote so review work is
 * refreshed against the current immutable snapshot. Validation failures that
 * retrying the same quote cannot fix are non-retryable. Unknown codes degrade
 * to `CONTEXT_INSUFFICIENT` rather than guessing.
 */
export function buildQuoteVerificationDiagnostics(errorCode: string): TransactionReviewDiagnostic[] {
  switch (errorCode) {
    case "STALE_QUOTE":
    case "CONFIG_DRIFT":
    case "ASSUMPTION_DRIFT":
    case "INVALID_FINGERPRINT":
      return buildTransactionReviewFailureDiagnostics("QUOTE_REFRESH_REQUIRED", {
        stage: "quote-verification",
      });
    case "INVALID_QUOTE":
    case "ROUTE_MISMATCH":
    case "UNSUPPORTED_ASSET":
    case "SLIPPAGE_EXCEEDED":
      return buildTransactionReviewFailureDiagnostics("VALIDATION_FAILED", {
        stage: "quote-verification",
      });
    default:
      return buildTransactionReviewFailureDiagnostics("CONTEXT_INSUFFICIENT", {
        stage: "quote-verification",
      });
  }
}

/**
 * Failure after the user confirmed. Failures at/after submission are ambiguous
 * (the transaction may be on the network) so they are marked retry-unsafe;
 * earlier failures never reached the network.
 */
export function buildExecutionDiagnostics(
  failedAt: "signing" | "submitting" | "polling" | "idle",
): TransactionReviewDiagnostic[] {
  if (failedAt === "polling") {
    return buildTransactionReviewFailureDiagnostics("RETRY_UNSAFE", {
      stage: "confirmation",
      affectedStages: ["submission", "confirmation"],
    });
  }
  if (failedAt === "submitting") {
    return buildTransactionReviewFailureDiagnostics("RETRY_UNSAFE", { stage: "submission" });
  }
  if (failedAt === "signing") {
    return buildTransactionReviewFailureDiagnostics("STAGE_UNAVAILABLE", { stage: "wallet-signing" });
  }
  return buildTransactionReviewFailureDiagnostics("CONTEXT_INSUFFICIENT", { stage: "unknown" });
}

/** True when the text contains no URL, email, address, long hash or path. */
export function isPrivacySafeReviewText(value: string): boolean {
  if (typeof value !== "string") return false;
  return !(
    /https?:\/\//i.test(value) ||
    /[\w.+-]+@[\w-]+\.[\w.-]+/.test(value) ||
    /\b[GSC][A-Z2-7]{55}\b/.test(value) ||
    /\b[a-f0-9]{32,}\b/i.test(value) ||
    /(?:\/[\w.-]+){2,}/.test(value)
  );
}

export function areTransactionReviewDiagnosticsPrivacySafe(
  diagnostics: ReadonlyArray<Pick<TransactionReviewDiagnostic, "privacySafe" | "summary" | "remediation">>,
): boolean {
  return diagnostics.every(
    (d) =>
      d.privacySafe === true &&
      isPrivacySafeReviewText(d.summary) &&
      isPrivacySafeReviewText(d.remediation),
  );
}

const VALID_CODES = new Set<string>(Object.keys(TEMPLATES));
const VALID_STAGES = new Set<string>(Object.keys(TRANSACTION_REVIEW_STAGE_LABELS));

/**
 * Parse untrusted `diagnostics` from an API body. Only structurally valid
 * entries survive, and their text is rebuilt from our templates, so a
 * malformed or hostile response cannot inject text into the UI. Returns an
 * empty array when nothing usable is present.
 */
export function parseTransactionReviewDiagnostics(input: unknown): TransactionReviewDiagnostic[] {
  if (!Array.isArray(input)) return [];
  const out: TransactionReviewDiagnostic[] = [];
  for (const item of input.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const { code, stage } = item as { code?: unknown; stage?: unknown };
    if (typeof code !== "string" || typeof stage !== "string") continue;
    if (!VALID_CODES.has(code) || !VALID_STAGES.has(stage)) continue;
    out.push(
      buildTransactionReviewDiagnostic(code as TransactionReviewDiagnosticCode, {
        stage: stage as TransactionReviewStage,
      }),
    );
  }
  return out;
}
