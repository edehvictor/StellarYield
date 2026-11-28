/**
 * Privacy-safe diagnostics for the yield data display (#1877).
 *
 * When `GET /api/yields` (or the client's handling of it) fails, the user and
 * the developer need to know *where* it failed and *what to do next*, without
 * the response leaking stack traces, provider URLs, credentials or other
 * internals. This module is the single contract both layers share:
 *
 * - the server builds a `YieldDiagnostic` from the stage it was executing when
 *   the failure happened (`buildYieldDiagnostic`);
 * - the client turns whatever it actually received — a complete diagnostic, a
 *   partial one, a legacy `{ error, message }` body, garbage, or nothing at all
 *   — into a renderable `ResolvedYieldDiagnostic` (`resolveYieldDiagnostic`).
 *
 * All user-facing copy comes from `YIELD_DIAGNOSTIC_CATALOG`, keyed by a stable
 * code. Free text from a response body is never rendered, so a misbehaving
 * server or proxy cannot inject internal details into the UI.
 *
 * When the failing stage cannot be determined, the diagnostic says so
 * (`stage: "unknown"`, `stageKnown: false`) and carries **no remediation**
 * rather than guessing one.
 *
 * Pure and dependency-free: safe to import from a browser bundle or Node.
 */

/** Processing stages of the yield data flow, in execution order. */
export const YIELD_FAILURE_STAGES = [
  /** Server: query parameters (fee assumptions) were rejected. */
  "input_validation",
  /** Server: loading yield source data (network snapshot, protocol data, cache). */
  "source_retrieval",
  /** Server: scoring a yield source's reliability and freshness. */
  "reliability_scoring",
  /** Server: computing net yield, fee attribution and fee history. */
  "yield_enrichment",
  /** Server: encoding the response body. */
  "response_serialization",
  /** Client: the request never produced an HTTP response (offline, DNS, CORS, timeout). */
  "network",
  /** Client: a response arrived but its body was not the expected shape. */
  "response_parsing",
  /** The failing stage could not be determined from the available context. */
  "unknown",
] as const;

export type YieldFailureStage = (typeof YIELD_FAILURE_STAGES)[number];

/** Stable diagnostic codes. One code per stage. */
export type YieldDiagnosticCode =
  | "YIELD_INPUT_INVALID"
  | "YIELD_SOURCE_UNAVAILABLE"
  | "YIELD_RELIABILITY_UNAVAILABLE"
  | "YIELD_ENRICHMENT_FAILED"
  | "YIELD_SERIALIZATION_FAILED"
  | "YIELD_NETWORK_UNREACHABLE"
  | "YIELD_RESPONSE_MALFORMED"
  | "YIELD_STAGE_UNKNOWN";

/** Diagnostic attached by the server to a failed `/api/yields` response. */
export interface YieldDiagnostic {
  code: YieldDiagnosticCode;
  stage: YieldFailureStage;
  /** False only for `stage: "unknown"`. */
  stageKnown: boolean;
  /** Safe, human-readable explanation of what failed. */
  summary: string;
  /** Suggested next step, or `null` when there is not enough evidence for one. */
  remediation: string | null;
  /** Whether repeating the same request unchanged can succeed. */
  retryable: boolean;
  /** Correlation handle for support/logs. Opaque; never contains user data. */
  requestId?: string;
}

/** What the client renders. */
export interface ResolvedYieldDiagnostic extends YieldDiagnostic {
  /** Short heading for the notice. */
  title: string;
  /**
   * `server`: the response carried a recognised diagnostic.
   * `client`: the client derived it (network/parse failure, or the response
   * carried no usable diagnostic).
   */
  source: "server" | "client";
  /** HTTP status, when a response was received. */
  httpStatus?: number;
}

interface CatalogEntry {
  stage: YieldFailureStage;
  title: string;
  summary: string;
  remediation: string | null;
  retryable: boolean;
}

export const YIELD_DIAGNOSTIC_CATALOG: Record<YieldDiagnosticCode, CatalogEntry> = {
  YIELD_INPUT_INVALID: {
    stage: "input_validation",
    title: "Invalid yield request",
    summary: "One or more fee assumption parameters were not accepted.",
    remediation:
      "Reset the fee assumptions to their defaults, or use numeric values between 0 and 10000 basis points.",
    retryable: false,
  },
  YIELD_SOURCE_UNAVAILABLE: {
    stage: "source_retrieval",
    title: "Yield sources unavailable",
    summary: "Yield data could not be loaded from the configured sources.",
    remediation:
      "Retry in a minute. If it keeps failing, check the network status page or the Diagnostics panel for provider health.",
    retryable: true,
  },
  YIELD_RELIABILITY_UNAVAILABLE: {
    stage: "reliability_scoring",
    title: "Source health check failed",
    summary: "Yield data was loaded, but its freshness and reliability could not be verified.",
    remediation:
      "Retry shortly. Rates are withheld rather than shown without a health check.",
    retryable: true,
  },
  YIELD_ENRICHMENT_FAILED: {
    stage: "yield_enrichment",
    title: "Net yield calculation failed",
    summary: "Yield data was loaded, but net yield or fee details could not be calculated.",
    remediation:
      "Retry, or reset custom fee assumptions to their defaults if you changed them.",
    retryable: true,
  },
  YIELD_SERIALIZATION_FAILED: {
    stage: "response_serialization",
    title: "Yield response could not be prepared",
    summary: "Yield data was processed, but the response could not be encoded.",
    remediation: "Retry. If it persists, report it with the request id below.",
    retryable: true,
  },
  YIELD_NETWORK_UNREACHABLE: {
    stage: "network",
    title: "Yield service unreachable",
    summary: "The request did not reach the yield service.",
    remediation: "Check your internet connection, then retry.",
    retryable: true,
  },
  YIELD_RESPONSE_MALFORMED: {
    stage: "response_parsing",
    title: "Unexpected yield response",
    summary: "The yield service answered, but the response was not in the expected format.",
    remediation:
      "Reload the page to pick up the latest app version. If it persists, report it with the request id below.",
    retryable: true,
  },
  YIELD_STAGE_UNKNOWN: {
    stage: "unknown",
    title: "Yield data unavailable",
    summary:
      "Yield data could not be loaded, and the failing step could not be determined.",
    remediation: null,
    retryable: true,
  },
};

const CODE_BY_STAGE: Record<YieldFailureStage, YieldDiagnosticCode> = {
  input_validation: "YIELD_INPUT_INVALID",
  source_retrieval: "YIELD_SOURCE_UNAVAILABLE",
  reliability_scoring: "YIELD_RELIABILITY_UNAVAILABLE",
  yield_enrichment: "YIELD_ENRICHMENT_FAILED",
  response_serialization: "YIELD_SERIALIZATION_FAILED",
  network: "YIELD_NETWORK_UNREACHABLE",
  response_parsing: "YIELD_RESPONSE_MALFORMED",
  unknown: "YIELD_STAGE_UNKNOWN",
};

/** Request ids are opaque tokens: letters, digits, `-`, `_`, `.`, `:`; max 64 chars. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function isYieldFailureStage(value: unknown): value is YieldFailureStage {
  return (
    typeof value === "string" &&
    (YIELD_FAILURE_STAGES as readonly string[]).includes(value)
  );
}

export function isYieldDiagnosticCode(value: unknown): value is YieldDiagnosticCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(YIELD_DIAGNOSTIC_CATALOG, value)
  );
}

/** Return `value` if it is a safe opaque request id, otherwise `undefined`. */
export function sanitizeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

function fromCode(code: YieldDiagnosticCode, requestId: unknown): YieldDiagnostic {
  const entry = YIELD_DIAGNOSTIC_CATALOG[code];
  const diagnostic: YieldDiagnostic = {
    code,
    stage: entry.stage,
    stageKnown: entry.stage !== "unknown",
    summary: entry.summary,
    remediation: entry.remediation,
    retryable: entry.retryable,
  };
  const safeId = sanitizeRequestId(requestId);
  if (safeId) diagnostic.requestId = safeId;
  return diagnostic;
}

/**
 * Server side: build the diagnostic for a failure at `stage`.
 *
 * Accepts anything for `stage`; a missing or unrecognised value yields the
 * explicit unknown-stage diagnostic instead of a guessed one.
 */
export function buildYieldDiagnostic(stage: unknown, requestId?: unknown): YieldDiagnostic {
  const code = isYieldFailureStage(stage) ? CODE_BY_STAGE[stage] : "YIELD_STAGE_UNKNOWN";
  return fromCode(code, requestId);
}

export interface ResolveContext {
  /** HTTP status of the response, when one was received. */
  httpStatus?: number | null;
  /** True when the request failed before any HTTP response arrived. */
  networkFailure?: boolean;
  /** True when a 2xx response body did not have the expected shape. */
  malformedSuccess?: boolean;
  /** Request id taken from response headers, if any. */
  requestId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Client side: turn whatever was received into a renderable diagnostic.
 *
 * Never throws. Resolution order:
 * 1. a body with a recognised `diagnostic.code` → that code's catalog entry;
 * 2. else a body with a recognised `diagnostic.stage` → that stage's entry;
 * 3. else the transport context (network failure / malformed 2xx body);
 * 4. else the unknown-stage fallback, which carries no remediation.
 *
 * Copy always comes from the catalog; free text in the body is ignored.
 */
export function resolveYieldDiagnostic(
  body: unknown,
  context: ResolveContext = {},
): ResolvedYieldDiagnostic {
  const raw = isRecord(body) && isRecord(body.diagnostic) ? body.diagnostic : null;
  const bodyRequestId =
    (raw && sanitizeRequestId(raw.requestId)) ||
    (isRecord(body) ? sanitizeRequestId(body.requestId) : undefined);
  const requestId = bodyRequestId ?? sanitizeRequestId(context.requestId);

  let code: YieldDiagnosticCode;
  let source: "server" | "client";
  if (raw && isYieldDiagnosticCode(raw.code)) {
    code = raw.code;
    source = "server";
  } else if (raw && isYieldFailureStage(raw.stage)) {
    code = CODE_BY_STAGE[raw.stage];
    source = "server";
  } else if (context.networkFailure) {
    code = "YIELD_NETWORK_UNREACHABLE";
    source = "client";
  } else if (context.malformedSuccess) {
    code = "YIELD_RESPONSE_MALFORMED";
    source = "client";
  } else {
    code = "YIELD_STAGE_UNKNOWN";
    source = "client";
  }

  const resolved: ResolvedYieldDiagnostic = {
    ...fromCode(code, requestId),
    title: YIELD_DIAGNOSTIC_CATALOG[code].title,
    source,
  };
  if (typeof context.httpStatus === "number" && Number.isFinite(context.httpStatus)) {
    resolved.httpStatus = context.httpStatus;
  }
  return resolved;
}
