import type { GovernanceConfig } from "./types";

export interface SignerRotationAuditRecord {
  timestamp: string;
  actor: string;
  contractId: string;
  previousThreshold: number;
  nextThreshold: number;
  addedSigners: string[];
  removedSigners: string[];
}

export const SIGNER_ROTATION_AUDIT_HEADERS = [
  "timestamp",
  "actor",
  "contract_id",
  "previous_threshold",
  "next_threshold",
  "added_signers",
  "removed_signers",
] as const;

export function createSignerRotationAuditRecord(
  previous: GovernanceConfig,
  next: GovernanceConfig,
  actor: string,
  timestamp: string,
): SignerRotationAuditRecord | null {
  const previousSigners = new Set(previous.signers);
  const nextSigners = new Set(next.signers);
  const addedSigners = [...nextSigners].filter(
    (signer) => !previousSigners.has(signer),
  );
  const removedSigners = [...previousSigners].filter(
    (signer) => !nextSigners.has(signer),
  );

  if (
    addedSigners.length === 0 &&
    removedSigners.length === 0 &&
    previous.threshold === next.threshold
  ) {
    return null;
  }

  return {
    timestamp,
    actor,
    contractId: next.contractId,
    previousThreshold: previous.threshold,
    nextThreshold: next.threshold,
    addedSigners,
    removedSigners,
  };
}

function escapeCsvCell(value: string | number): string {
  let text = String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeSignerRotationAuditCsv(
  records: SignerRotationAuditRecord[],
): string {
  const rows = records.map((record) =>
    [
      record.timestamp,
      record.actor,
      record.contractId,
      record.previousThreshold,
      record.nextThreshold,
      record.addedSigners.join("; "),
      record.removedSigners.join("; "),
    ]
      .map(escapeCsvCell)
      .join(","),
  );

  return [SIGNER_ROTATION_AUDIT_HEADERS.join(","), ...rows].join("\r\n");
}
