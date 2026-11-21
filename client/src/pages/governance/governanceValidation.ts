import type { GovernanceConfig, PendingTransaction, SignerRecord } from "./types";
import type { SignerRotationAuditRecord } from "./signerRotationAudit";

export type GovernanceValidationErrorCode =
  | "MALFORMED_GOVERNANCE_CONFIG"
  | "MALFORMED_PROPOSAL_TRANSACTION"
  | "MALFORMED_SIGNATURE"
  | "MALFORMED_EXECUTION_PAYLOAD";

export class GovernanceValidationError extends Error {
  readonly code: GovernanceValidationErrorCode;
  readonly field?: string;

  constructor(
    code: GovernanceValidationErrorCode,
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = "GovernanceValidationError";
    this.code = code;
    this.field = field;
  }
}

const VALID_TX_STATUSES = new Set<PendingTransaction["status"]>([
  "pending",
  "ready",
  "executed",
  "expired",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidSignerRecord(value: unknown): value is SignerRecord {
  return (
    isPlainObject(value) &&
    isNonEmptyString(value.publicKey) &&
    typeof value.signedAt === "number" &&
    Number.isFinite(value.signedAt)
  );
}

export function isValidPendingTransaction(
  value: unknown,
): value is PendingTransaction {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    typeof value.description === "string" &&
    isNonEmptyString(value.method) &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === "string") &&
    isNonEmptyString(value.xdr) &&
    Array.isArray(value.signatures) &&
    value.signatures.every(isValidSignerRecord) &&
    typeof value.threshold === "number" &&
    Number.isInteger(value.threshold) &&
    value.threshold >= 1 &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    isNonEmptyString(value.createdBy) &&
    typeof value.status === "string" &&
    VALID_TX_STATUSES.has(value.status as PendingTransaction["status"])
  );
}

export function parseStoredTransactions(raw: unknown): PendingTransaction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidPendingTransaction);
}

export function parseStoredConfig(
  raw: unknown,
  fallback: GovernanceConfig,
): GovernanceConfig {
  if (!isPlainObject(raw)) return fallback;
  if (
    !Array.isArray(raw.signers) ||
    !raw.signers.every(isNonEmptyString) ||
    typeof raw.threshold !== "number" ||
    !Number.isInteger(raw.threshold) ||
    raw.threshold < 1 ||
    typeof raw.contractId !== "string"
  ) {
    return fallback;
  }
  return {
    signers: raw.signers.map((s) => s.trim()),
    threshold: raw.threshold,
    contractId: raw.contractId,
  };
}

export function parseStoredAuditRecords(
  raw: unknown,
): SignerRotationAuditRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is SignerRotationAuditRecord =>
      isPlainObject(item) &&
      isNonEmptyString(item.timestamp) &&
      isNonEmptyString(item.actor) &&
      typeof item.contractId === "string" &&
      typeof item.previousThreshold === "number" &&
      Number.isInteger(item.previousThreshold) &&
      typeof item.nextThreshold === "number" &&
      Number.isInteger(item.nextThreshold) &&
      Array.isArray(item.addedSigners) &&
      item.addedSigners.every((s) => typeof s === "string") &&
      Array.isArray(item.removedSigners) &&
      item.removedSigners.every((s) => typeof s === "string"),
  );
}

export function validateGovernanceConfigInput(
  config: GovernanceConfig,
): GovernanceConfig {
  if (!isPlainObject(config)) {
    throw new GovernanceValidationError(
      "MALFORMED_GOVERNANCE_CONFIG",
      "Governance configuration must be an object.",
    );
  }
  if (!Array.isArray(config.signers) || !config.signers.every(isNonEmptyString)) {
    throw new GovernanceValidationError(
      "MALFORMED_GOVERNANCE_CONFIG",
      "Signers must be an array of non-empty Stellar addresses.",
      "signers",
    );
  }

  const trimmedSigners = config.signers.map((s) => s.trim());
  if (new Set(trimmedSigners).size !== trimmedSigners.length) {
    throw new GovernanceValidationError(
      "MALFORMED_GOVERNANCE_CONFIG",
      "Signer addresses must not contain duplicates.",
      "signers",
    );
  }

  if (
    typeof config.threshold !== "number" ||
    !Number.isInteger(config.threshold) ||
    config.threshold < 1
  ) {
    throw new GovernanceValidationError(
      "MALFORMED_GOVERNANCE_CONFIG",
      "Threshold must be a positive integer.",
      "threshold",
    );
  }

  if (trimmedSigners.length > 0 && config.threshold > trimmedSigners.length) {
    throw new GovernanceValidationError(
      "MALFORMED_GOVERNANCE_CONFIG",
      "Threshold cannot exceed the number of configured signers.",
      "threshold",
    );
  }

  if (typeof config.contractId !== "string") {
    throw new GovernanceValidationError(
      "MALFORMED_GOVERNANCE_CONFIG",
      "Contract ID must be a string.",
      "contractId",
    );
  }

  return {
    signers: trimmedSigners,
    threshold: config.threshold,
    contractId: config.contractId.trim(),
  };
}

export function validatePendingTransactionInput(
  tx: PendingTransaction,
): PendingTransaction {
  if (!isValidPendingTransaction(tx)) {
    throw new GovernanceValidationError(
      "MALFORMED_PROPOSAL_TRANSACTION",
      "Proposal transaction contains missing or invalid fields.",
    );
  }
  return {
    ...tx,
    id: tx.id.trim(),
    method: tx.method.trim(),
    xdr: tx.xdr.trim(),
    createdBy: tx.createdBy.trim(),
  };
}

export function validateSignatureInput(
  txId: string,
  publicKey: string,
): { txId: string; publicKey: string } {
  if (!isNonEmptyString(txId)) {
    throw new GovernanceValidationError(
      "MALFORMED_SIGNATURE",
      "Transaction id must be a non-empty string.",
      "txId",
    );
  }
  if (!isNonEmptyString(publicKey)) {
    throw new GovernanceValidationError(
      "MALFORMED_SIGNATURE",
      "Signer public key must be a non-empty string.",
      "publicKey",
    );
  }
  return { txId: txId.trim(), publicKey: publicKey.trim() };
}
