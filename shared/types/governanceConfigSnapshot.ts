/**
 * Governance configuration snapshot and fingerprint (#1894)
 *
 * Governance work (forecasts, quorum checks, proposals) is prepared against a
 * particular signer/threshold/contract configuration. This module gives both
 * the client and server one immutable, canonical SHA-256 fingerprint for that
 * configuration so stale work can be rejected before it mutates local state or
 * triggers an execution.
 *
 * Deliberately excluded from the snapshot:
 * - pending transactions, signatures, balances and proposal status, which
 *   change as work progresses and must not invalidate a caller's snapshot;
 * - timestamps or counters, which would make an otherwise identical
 *   configuration produce a different fingerprint.
 */

import {
  formatShortFingerprint,
  sha256Pure,
  stableStringify,
} from "./quoteAssumptionFingerprint";

export const GOVERNANCE_CONFIG_FINGERPRINT_DOMAIN =
  "stellaryield_governance_config_v1";

export interface GovernanceConfigSnapshot {
  /** Signer public keys, stored in canonical (sorted, de-duplicated) order. */
  signers: string[];
  /** Required number of signatures. */
  threshold: number;
  /** Governance/vault contract the configuration applies to. */
  contractId: string;
}

export interface GovernanceConfigFingerprintResult {
  snapshot: GovernanceConfigSnapshot;
  /** 64-character lowercase SHA-256 hex digest. */
  fingerprint: string;
  /** Human-readable compact fingerprint (e.g. "gcf-8f3a1c…4b2d"). */
  shortFingerprint: string;
  /** Deterministic canonical payload from which the digest was computed. */
  canonicalPayload: string;
}

export type GovernanceConfigVerificationStatus = "valid" | "stale" | "invalid";

export interface GovernanceConfigFingerprintVerification {
  valid: boolean;
  status: GovernanceConfigVerificationStatus;
  code:
    | "GOVERNANCE_CONFIG_CURRENT"
    | "STALE_GOVERNANCE_CONFIG"
    | "INVALID_GOVERNANCE_CONFIG";
  message: string;
  /** Fingerprint of the live configuration snapshot. */
  expectedFingerprint: string;
  /** Fingerprint supplied by the caller, when present. */
  actualFingerprint?: string;
  driftReasons: string[];
}

export interface GovernanceConfigValidationIssue {
  field: string;
  message: string;
}

export interface GovernanceConfigValidationResult {
  valid: boolean;
  issues: GovernanceConfigValidationIssue[];
  snapshot: GovernanceConfigSnapshot;
}

export type GovernanceConfigErrorCode =
  | "STALE_GOVERNANCE_CONFIG"
  | "INVALID_GOVERNANCE_CONFIG";

export class GovernanceConfigSnapshotError extends Error {
  readonly code: GovernanceConfigErrorCode;
  readonly expectedFingerprint: string;
  readonly actualFingerprint?: string;

  constructor(
    code: GovernanceConfigErrorCode,
    message: string,
    expectedFingerprint: string,
    actualFingerprint?: string,
  ) {
    super(message);
    this.name = "GovernanceConfigSnapshotError";
    this.code = code;
    this.expectedFingerprint = expectedFingerprint;
    this.actualFingerprint = actualFingerprint;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a configuration into its canonical snapshot. Signer order and
 * whitespace do not affect the fingerprint; duplicate signers are collapsed.
 */
export function normalizeGovernanceConfigSnapshot(
  input: unknown,
): GovernanceConfigSnapshot {
  const record = isRecord(input) ? input : {};
  const rawSigners = Array.isArray(record.signers) ? record.signers : [];
  const signers = Array.from(
    new Set(
      rawSigners
        .filter((signer): signer is string => typeof signer === "string")
        .map((signer) => signer.trim())
        .filter(Boolean),
    ),
  ).sort();

  const rawThreshold = Number(record.threshold);
  const threshold = Number.isFinite(rawThreshold)
    ? Math.floor(rawThreshold)
    : 0;
  const contractId =
    typeof record.contractId === "string" ? record.contractId.trim() : "";

  return { signers, threshold, contractId };
}

/**
 * Validates the shape of a governance configuration before it is persisted or
 * used to produce work. It intentionally does not require a populated signer
 * set, because the dashboard starts from an empty default configuration.
 */
export function validateGovernanceConfigSnapshot(
  input: unknown,
): GovernanceConfigValidationResult {
  const issues: GovernanceConfigValidationIssue[] = [];
  const record = isRecord(input) ? input : {};

  if (!isRecord(input)) {
    issues.push({ field: "config", message: "Configuration must be an object." });
  }

  if (!Array.isArray(record.signers)) {
    issues.push({ field: "signers", message: "signers must be an array." });
  } else {
    const seen = new Set<string>();
    record.signers.forEach((signer, index) => {
      if (typeof signer !== "string" || signer.trim() === "") {
        issues.push({
          field: `signers[${index}]`,
          message: "Signer addresses must be non-empty strings.",
        });
        return;
      }
      const normalized = signer.trim();
      if (seen.has(normalized)) {
        issues.push({
          field: `signers[${index}]`,
          message: "Signer addresses must be unique.",
        });
      }
      seen.add(normalized);
    });
  }

  const threshold = record.threshold;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    !Number.isInteger(threshold) ||
    threshold < 1
  ) {
    issues.push({
      field: "threshold",
      message: "threshold must be an integer of at least 1.",
    });
  }

  if (typeof record.contractId !== "string") {
    issues.push({
      field: "contractId",
      message: "contractId must be a string.",
    });
  }

  const snapshot = normalizeGovernanceConfigSnapshot(input);
  if (
    snapshot.signers.length > 0 &&
    snapshot.threshold > snapshot.signers.length
  ) {
    issues.push({
      field: "threshold",
      message: "threshold cannot exceed the number of unique signers.",
    });
  }

  return { valid: issues.length === 0, issues, snapshot };
}

export function canonicalizeGovernanceConfigSnapshot(
  snapshot: GovernanceConfigSnapshot,
): Record<string, unknown> {
  const normalized = normalizeGovernanceConfigSnapshot(snapshot);
  return {
    contractId: normalized.contractId,
    domain: GOVERNANCE_CONFIG_FINGERPRINT_DOMAIN,
    signers: normalized.signers,
    threshold: normalized.threshold,
  };
}

export function computeGovernanceConfigFingerprint(
  snapshot: GovernanceConfigSnapshot,
): GovernanceConfigFingerprintResult {
  const normalized = normalizeGovernanceConfigSnapshot(snapshot);
  const canonicalPayload = stableStringify(
    canonicalizeGovernanceConfigSnapshot(normalized),
  );
  const fingerprint = sha256Pure(canonicalPayload);

  return {
    snapshot: normalized,
    fingerprint,
    shortFingerprint: formatShortFingerprint(fingerprint, "gcf-"),
    canonicalPayload,
  };
}

function normalizeClaimedFingerprint(claimed: unknown): string {
  return typeof claimed === "string"
    ? claimed.trim().toLowerCase().replace(/^0x/i, "")
    : "";
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Compares a claimed fingerprint with the live configuration snapshot.
 *
 * - `valid` means the work was prepared against exactly this configuration.
 * - `stale` means the configuration changed; refresh and retry.
 * - `invalid` means the claim is missing or malformed.
 */
export function verifyGovernanceConfigFingerprint(
  snapshot: GovernanceConfigSnapshot,
  claimedFingerprint: unknown,
): GovernanceConfigFingerprintVerification {
  const expectedFingerprint = computeGovernanceConfigFingerprint(snapshot).fingerprint;
  const actualFingerprint = normalizeClaimedFingerprint(claimedFingerprint);

  if (!isSha256Hex(actualFingerprint)) {
    return {
      valid: false,
      status: "invalid",
      code: "INVALID_GOVERNANCE_CONFIG",
      message:
        "Missing or malformed governance configuration fingerprint. Refresh the configuration snapshot and retry.",
      expectedFingerprint,
      actualFingerprint: actualFingerprint || undefined,
      driftReasons: ["The supplied fingerprint is not a 64-character SHA-256 digest."],
    };
  }

  if (actualFingerprint !== expectedFingerprint) {
    return {
      valid: false,
      status: "stale",
      code: "STALE_GOVERNANCE_CONFIG",
      message:
        "Governance configuration changed since this work was prepared. Refresh the configuration snapshot and retry.",
      expectedFingerprint,
      actualFingerprint,
      driftReasons: [
        "The signer set, threshold or contract differs from the captured snapshot.",
      ],
    };
  }

  return {
    valid: true,
    status: "valid",
    code: "GOVERNANCE_CONFIG_CURRENT",
    message: "Governance configuration matches the captured snapshot.",
    expectedFingerprint,
    actualFingerprint,
    driftReasons: [],
  };
}

/**
 * Throws a typed error when a claimed fingerprint does not match the live
 * configuration. Callers can use `error.code` to surface a recoverable
 * "refresh and retry" state without mutating their existing work.
 */
export function assertGovernanceConfigFingerprint(
  snapshot: GovernanceConfigSnapshot,
  claimedFingerprint: unknown,
): string {
  const verification = verifyGovernanceConfigFingerprint(
    snapshot,
    claimedFingerprint,
  );
  if (!verification.valid) {
    const code: GovernanceConfigErrorCode =
      verification.status === "stale"
        ? "STALE_GOVERNANCE_CONFIG"
        : "INVALID_GOVERNANCE_CONFIG";
    throw new GovernanceConfigSnapshotError(
      code,
      verification.message,
      verification.expectedFingerprint,
      verification.actualFingerprint,
    );
  }
  return verification.expectedFingerprint;
}
