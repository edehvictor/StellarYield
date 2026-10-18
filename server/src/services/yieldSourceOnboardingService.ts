/**
 * Yield Source Onboarding Checklist (#1156)
 *
 * Validates yield source entries against the required onboarding metadata —
 * protocol, asset, fee, risk, and freshness — before they can be promoted and
 * become visible on production routes (e.g. `GET /api/analytics/sources/health`).
 *
 * The validator is a pure function that never throws. It returns every missing
 * required field plus actionable, field-level issues so operators can fix an
 * entry in a single pass, and `promoteYieldSource` (see
 * {@link yieldSourceRegistryService}) refuses any entry whose checklist fails.
 *
 * Existing registry entries carry complete onboarding metadata, so they keep
 * passing unchanged.
 */

/** Required onboarding metadata for a yield source (#1156). */
export interface YieldSourceOnboardingMetadata {
  /** Protocol (or data domain for oracles) this source primarily serves. */
  protocol: string;
  /** Primary asset this source quotes (e.g. "USDC", "XLM-USDC"). */
  asset: string;
  /** Protocol fee schedule in basis points. Use 0/0 when no fee applies. */
  fee: { managementBps: number; performanceBps: number };
  /** Risk classification exposed alongside yields from this source. */
  risk: { level: "Low" | "Medium" | "High"; score?: number };
  /** Maximum acceptable data age in seconds before data counts as stale. */
  freshness: { maxAgeSeconds: number };
}

/** The five required onboarding sections, in checklist order. */
export const REQUIRED_ONBOARDING_FIELDS = [
  "protocol",
  "asset",
  "fee",
  "risk",
  "freshness",
] as const;

export type OnboardingChecklistField = (typeof REQUIRED_ONBOARDING_FIELDS)[number];

/** A single actionable checklist failure, keyed by dotted field path. */
export interface OnboardingChecklistIssue {
  /** Dotted path of the offending field (e.g. "onboarding.fee.managementBps"). */
  field: string;
  /** Operator-facing description of what is wrong and how to fix it. */
  message: string;
}

/** Result of running the onboarding checklist against one entry. */
export interface OnboardingChecklistResult {
  valid: boolean;
  /** Every missing required field, named in dotted-path form. */
  missingFields: string[];
  /** Field-level problems with present-but-invalid values. */
  issues: OnboardingChecklistIssue[];
  /** Human-readable summary naming every failure (or confirming success). */
  message: string;
}

/** Loose input shape: runtime values are validated, not trusted. */
export interface YieldSourceOnboardingInput {
  id?: unknown;
  name?: unknown;
  source?: unknown;
  onboarding?: unknown;
}

export type OnboardingFailureCode =
  | "ONBOARDING_CHECKLIST_FAILED"
  | "YIELD_SOURCE_ALREADY_REGISTERED";

/**
 * Typed failure raised when an entry cannot be promoted. Carries the full
 * checklist result so routes can return every missing field to the operator.
 */
export class YieldSourceOnboardingError extends Error {
  readonly code: OnboardingFailureCode;
  readonly statusCode: number;
  readonly details: {
    missingFields: string[];
    issues: OnboardingChecklistIssue[];
  };

  constructor(
    message: string,
    options: {
      code: OnboardingFailureCode;
      statusCode: number;
      missingFields?: string[];
      issues?: OnboardingChecklistIssue[];
    },
  ) {
    super(message);
    this.name = "YieldSourceOnboardingError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = {
      missingFields: options.missingFields ?? [],
      issues: options.issues ?? [],
    };
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const RISK_LEVELS: readonly string[] = ["Low", "Medium", "High"];
const MAX_FEE_BPS = 10_000;
/** 30 days — sanity cap that also catches millisecond/second mix-ups. */
const MAX_FRESHNESS_SECONDS = 30 * 24 * 60 * 60;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerBetween(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function entryLabel(entry: YieldSourceOnboardingInput): string {
  if (isNonEmptyString(entry?.id)) return entry.id;
  if (isNonEmptyString(entry?.name)) return entry.name;
  return "unknown source";
}

/**
 * Run the onboarding checklist for a yield source entry.
 *
 * Never throws. Reports missing required fields (`missingFields`) separately
 * from present-but-invalid values (`issues`), so the aggregate `message` names
 * every field an operator needs to touch.
 */
export function validateYieldSourceOnboarding(
  entry: YieldSourceOnboardingInput,
): OnboardingChecklistResult {
  const missingFields: string[] = [];
  const issues: OnboardingChecklistIssue[] = [];

  // Entry identity — required before an entry can be listed anywhere.
  if (!isNonEmptyString(entry?.id)) missingFields.push("id");
  if (!isNonEmptyString(entry?.name)) missingFields.push("name");
  if (!isNonEmptyString(entry?.source)) missingFields.push("source");

  const rawOnboarding = entry?.onboarding;
  if (!isPlainObject(rawOnboarding)) {
    for (const field of REQUIRED_ONBOARDING_FIELDS) {
      missingFields.push(`onboarding.${field}`);
    }
  } else {
    const onboarding = rawOnboarding as Record<string, unknown>;

    // protocol
    if (isMissing(onboarding.protocol)) {
      missingFields.push("onboarding.protocol");
    } else if (!isNonEmptyString(onboarding.protocol)) {
      issues.push({
        field: "onboarding.protocol",
        message:
          "onboarding.protocol must be a non-empty string naming the protocol (or data domain) this source serves.",
      });
    }

    // asset
    if (isMissing(onboarding.asset)) {
      missingFields.push("onboarding.asset");
    } else if (!isNonEmptyString(onboarding.asset)) {
      issues.push({
        field: "onboarding.asset",
        message:
          "onboarding.asset must be a non-empty string naming the primary asset this source quotes (e.g. \"USDC\").",
      });
    }

    // fee
    const fee = onboarding.fee;
    if (isMissing(fee)) {
      missingFields.push("onboarding.fee");
    } else if (!isPlainObject(fee)) {
      issues.push({
        field: "onboarding.fee",
        message:
          "onboarding.fee must be an object with managementBps and performanceBps in basis points (0-10000).",
      });
    } else {
      if (isMissing(fee.managementBps)) {
        missingFields.push("onboarding.fee.managementBps");
      } else if (!isIntegerBetween(fee.managementBps, 0, MAX_FEE_BPS)) {
        issues.push({
          field: "onboarding.fee.managementBps",
          message:
            "onboarding.fee.managementBps must be an integer between 0 and 10000 basis points.",
        });
      }
      if (isMissing(fee.performanceBps)) {
        missingFields.push("onboarding.fee.performanceBps");
      } else if (!isIntegerBetween(fee.performanceBps, 0, MAX_FEE_BPS)) {
        issues.push({
          field: "onboarding.fee.performanceBps",
          message:
            "onboarding.fee.performanceBps must be an integer between 0 and 10000 basis points.",
        });
      }
    }

    // risk
    const risk = onboarding.risk;
    if (isMissing(risk)) {
      missingFields.push("onboarding.risk");
    } else if (!isPlainObject(risk)) {
      issues.push({
        field: "onboarding.risk",
        message:
          "onboarding.risk must be an object with a level of Low, Medium, or High (and an optional 0-100 score).",
      });
    } else {
      if (isMissing(risk.level)) {
        missingFields.push("onboarding.risk.level");
      } else if (
        typeof risk.level !== "string" ||
        !RISK_LEVELS.includes(risk.level)
      ) {
        issues.push({
          field: "onboarding.risk.level",
          message: "onboarding.risk.level must be one of: Low, Medium, High.",
        });
      }
      if (risk.score !== undefined && risk.score !== null) {
        if (!isIntegerBetween(risk.score, 0, 100)) {
          issues.push({
            field: "onboarding.risk.score",
            message:
              "onboarding.risk.score must be an integer between 0 and 100 when provided.",
          });
        }
      }
    }

    // freshness
    const freshness = onboarding.freshness;
    if (isMissing(freshness)) {
      missingFields.push("onboarding.freshness");
    } else if (!isPlainObject(freshness)) {
      issues.push({
        field: "onboarding.freshness",
        message:
          "onboarding.freshness must be an object with maxAgeSeconds (seconds, not milliseconds).",
      });
    } else {
      if (isMissing(freshness.maxAgeSeconds)) {
        missingFields.push("onboarding.freshness.maxAgeSeconds");
      } else if (
        !isIntegerBetween(freshness.maxAgeSeconds, 1, MAX_FRESHNESS_SECONDS)
      ) {
        issues.push({
          field: "onboarding.freshness.maxAgeSeconds",
          message:
            "onboarding.freshness.maxAgeSeconds must be a positive integer of seconds not exceeding 2592000 (30 days).",
        });
      }
    }
  }

  const valid = missingFields.length === 0 && issues.length === 0;
  const parts: string[] = [];
  if (missingFields.length > 0) {
    parts.push(`Missing required onboarding fields: ${missingFields.join(", ")}.`);
  }
  for (const issue of issues) {
    parts.push(issue.message);
  }

  const label = entryLabel(entry);
  const message = valid
    ? `Yield source "${label}" passed the onboarding checklist.`
    : `Yield source "${label}" failed the onboarding checklist. ${parts.join(" ")}`;

  return { valid, missingFields, issues, message };
}
