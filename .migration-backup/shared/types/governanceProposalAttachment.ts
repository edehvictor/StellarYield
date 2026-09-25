/**
 * Attachment metadata for governance proposals (issue #1033).
 *
 * A governance proposal (see `client/src/pages/governance`) can reference
 * operational documents and transaction payloads alongside the admin action
 * it proposes:
 *  - `manifest`   — a deployment/registry manifest describing what is
 *                    changing (see docs/deployment-manifest-provenance.md).
 *  - `runbook`    — the operator runbook a reviewer should follow if the
 *                    proposal needs to be rolled back or escalated.
 *  - `transaction_payload` — the unsigned XDR envelope the proposal will
 *                    submit on-chain once it clears signing.
 *
 * This module defines the accepted metadata shape per kind and pure
 * validation logic shared by the client (inline form validation) and the
 * server (the authoritative check — the client check alone must never be
 * trusted to gate submission).
 */

export type ProposalAttachmentKind =
  | "manifest"
  | "runbook"
  | "transaction_payload";

export const PROPOSAL_ATTACHMENT_KINDS: readonly ProposalAttachmentKind[] = [
  "manifest",
  "runbook",
  "transaction_payload",
];

/** Content types accepted per attachment kind. */
export const ACCEPTED_ATTACHMENT_CONTENT_TYPES: Record<
  ProposalAttachmentKind,
  readonly string[]
> = {
  manifest: ["application/json"],
  runbook: ["text/markdown", "text/plain"],
  transaction_payload: ["application/xdr", "text/plain"],
};

/** Maximum accepted size per attachment kind, in bytes. */
export const MAX_ATTACHMENT_SIZE_BYTES: Record<ProposalAttachmentKind, number> = {
  manifest: 256 * 1024,
  runbook: 512 * 1024,
  transaction_payload: 64 * 1024,
};

export interface ProposalAttachmentInput {
  kind: ProposalAttachmentKind;
  /** Display filename — letters, numbers, dots, dashes, underscores only. */
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256 digest of the attachment content. */
  sha256: string;
  /**
   * Identifies the proposal manifest this attachment belongs to (e.g. a
   * manifest path/version such as `deployment-manifest.json@a1b2c3d`, or the
   * governance proposal/transaction id it supports). Required on every
   * attachment kind so runbooks and transaction payloads can always be
   * traced back to the manifest describing the change they relate to.
   */
  manifestReference: string;
  /** Required for `transaction_payload`: the unsigned XDR envelope. */
  xdr?: string;
}

export interface ProposalAttachmentValidationError {
  index: number;
  kind?: ProposalAttachmentKind;
  field: string;
  message: string;
}

export interface ProposalAttachmentValidationResult {
  valid: boolean;
  errors: ProposalAttachmentValidationError[];
}

const FILENAME_RE = /^[\w.\-]{1,120}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function isKnownKind(kind: unknown): kind is ProposalAttachmentKind {
  return (
    typeof kind === "string" &&
    (PROPOSAL_ATTACHMENT_KINDS as readonly string[]).includes(kind)
  );
}

/**
 * Validate a single attachment's metadata. Returns an empty array when the
 * attachment is valid. `index` is the attachment's position in the
 * proposal's attachment list, used to key UI error display.
 */
export function validateProposalAttachment(
  attachment: Partial<ProposalAttachmentInput>,
  index: number,
): ProposalAttachmentValidationError[] {
  const errors: ProposalAttachmentValidationError[] = [];

  if (!isKnownKind(attachment.kind)) {
    errors.push({
      index,
      field: "kind",
      message: `Attachment kind must be one of: ${PROPOSAL_ATTACHMENT_KINDS.join(", ")}.`,
    });
    // Without a known kind we can't check kind-specific rules (accepted
    // content types, size cap) meaningfully — stop here for this attachment.
    return errors;
  }

  const kind = attachment.kind;

  if (!attachment.filename || !FILENAME_RE.test(attachment.filename)) {
    errors.push({
      index,
      kind,
      field: "filename",
      message:
        "Filename is required and may only contain letters, numbers, dots, dashes, and underscores.",
    });
  }

  if (
    !attachment.contentType ||
    !ACCEPTED_ATTACHMENT_CONTENT_TYPES[kind].includes(attachment.contentType)
  ) {
    errors.push({
      index,
      kind,
      field: "contentType",
      message: `Unsupported content type for a ${kind} attachment. Accepted: ${ACCEPTED_ATTACHMENT_CONTENT_TYPES[kind].join(", ")}.`,
    });
  }

  if (
    typeof attachment.sizeBytes !== "number" ||
    !Number.isFinite(attachment.sizeBytes) ||
    attachment.sizeBytes <= 0
  ) {
    errors.push({
      index,
      kind,
      field: "sizeBytes",
      message: "sizeBytes is required and must be a positive number.",
    });
  } else if (attachment.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES[kind]) {
    errors.push({
      index,
      kind,
      field: "sizeBytes",
      message: `${kind} attachments must be ${Math.round(MAX_ATTACHMENT_SIZE_BYTES[kind] / 1024)}KB or smaller.`,
    });
  }

  if (!attachment.sha256 || !SHA256_HEX_RE.test(attachment.sha256)) {
    errors.push({
      index,
      kind,
      field: "sha256",
      message: "sha256 is required and must be a 64-character lowercase hex digest.",
    });
  }

  if (!attachment.manifestReference || !attachment.manifestReference.trim()) {
    errors.push({
      index,
      kind,
      field: "manifestReference",
      message: "manifestReference is required so this attachment can be traced back to a proposal manifest.",
    });
  }

  if (kind === "transaction_payload" && !attachment.xdr?.trim()) {
    errors.push({
      index,
      kind,
      field: "xdr",
      message: "Transaction payload attachments must include the XDR envelope.",
    });
  }

  return errors;
}

/** Validate a full list of proposal attachments. */
export function validateProposalAttachments(
  attachments: Partial<ProposalAttachmentInput>[],
): ProposalAttachmentValidationResult {
  const errors = attachments.flatMap((attachment, index) =>
    validateProposalAttachment(attachment, index),
  );
  return { valid: errors.length === 0, errors };
}
