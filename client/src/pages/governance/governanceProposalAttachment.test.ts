import { describe, it, expect } from "vitest";
import {
  validateProposalAttachment,
  validateProposalAttachments,
  ACCEPTED_ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  type ProposalAttachmentInput,
} from "../../../../shared/types/governanceProposalAttachment";

function manifest(overrides: Partial<ProposalAttachmentInput> = {}): ProposalAttachmentInput {
  return {
    kind: "manifest",
    filename: "deployment-manifest.json",
    contentType: "application/json",
    sizeBytes: 512,
    sha256: "a".repeat(64),
    manifestReference: "deployment-manifest.json@a1b2c3d",
    ...overrides,
  };
}

function runbook(overrides: Partial<ProposalAttachmentInput> = {}): ProposalAttachmentInput {
  return {
    kind: "runbook",
    filename: "emergency-runbook.md",
    contentType: "text/markdown",
    sizeBytes: 1024,
    sha256: "b".repeat(64),
    manifestReference: "deployment-manifest.json@a1b2c3d",
    ...overrides,
  };
}

function transactionPayload(
  overrides: Partial<ProposalAttachmentInput> = {},
): ProposalAttachmentInput {
  return {
    kind: "transaction_payload",
    filename: "set-keeper-fee.xdr",
    contentType: "application/xdr",
    sizeBytes: 256,
    sha256: "c".repeat(64),
    manifestReference: "deployment-manifest.json@a1b2c3d",
    xdr: "AAAAAgAAAABmock",
    ...overrides,
  };
}

describe("validateProposalAttachment — valid attachments", () => {
  it("accepts a valid manifest attachment", () => {
    expect(validateProposalAttachment(manifest(), 0)).toHaveLength(0);
  });

  it("accepts a valid runbook attachment", () => {
    expect(validateProposalAttachment(runbook(), 0)).toHaveLength(0);
  });

  it("accepts a valid transaction_payload attachment", () => {
    expect(validateProposalAttachment(transactionPayload(), 0)).toHaveLength(0);
  });
});

describe("validateProposalAttachment — malformed metadata", () => {
  it("rejects an unknown kind", () => {
    const errors = validateProposalAttachment(
      { ...manifest(), kind: "screenshot" as ProposalAttachmentInput["kind"] },
      0,
    );
    expect(errors.some((e) => e.field === "kind")).toBe(true);
  });

  it("rejects a missing filename", () => {
    const errors = validateProposalAttachment({ ...manifest(), filename: "" }, 0);
    expect(errors.some((e) => e.field === "filename")).toBe(true);
  });

  it("rejects a filename with path traversal characters", () => {
    const errors = validateProposalAttachment(
      { ...manifest(), filename: "../../etc/passwd" },
      0,
    );
    expect(errors.some((e) => e.field === "filename")).toBe(true);
  });

  it("rejects a content type not accepted for the given kind", () => {
    const errors = validateProposalAttachment(
      { ...manifest(), contentType: "application/pdf" },
      0,
    );
    expect(errors.some((e) => e.field === "contentType")).toBe(true);
  });

  it("rejects a runbook using the manifest's content type", () => {
    const errors = validateProposalAttachment(
      { ...runbook(), contentType: "application/json" },
      0,
    );
    expect(errors.some((e) => e.field === "contentType")).toBe(true);
  });

  it("rejects a non-positive sizeBytes", () => {
    const errors = validateProposalAttachment({ ...manifest(), sizeBytes: 0 }, 0);
    expect(errors.some((e) => e.field === "sizeBytes")).toBe(true);
  });

  it("rejects sizeBytes exceeding the per-kind cap", () => {
    const errors = validateProposalAttachment(
      { ...manifest(), sizeBytes: MAX_ATTACHMENT_SIZE_BYTES.manifest + 1 },
      0,
    );
    expect(errors.some((e) => e.field === "sizeBytes")).toBe(true);
  });

  it("accepts sizeBytes exactly at the per-kind cap", () => {
    const errors = validateProposalAttachment(
      { ...manifest(), sizeBytes: MAX_ATTACHMENT_SIZE_BYTES.manifest },
      0,
    );
    expect(errors).toHaveLength(0);
  });

  it("rejects a malformed sha256 (wrong length)", () => {
    const errors = validateProposalAttachment({ ...manifest(), sha256: "abc123" }, 0);
    expect(errors.some((e) => e.field === "sha256")).toBe(true);
  });

  it("rejects a malformed sha256 (uppercase hex)", () => {
    const errors = validateProposalAttachment(
      { ...manifest(), sha256: "A".repeat(64) },
      0,
    );
    expect(errors.some((e) => e.field === "sha256")).toBe(true);
  });

  it("rejects a transaction_payload attachment missing its xdr", () => {
    const errors = validateProposalAttachment(
      { ...transactionPayload(), xdr: undefined },
      0,
    );
    expect(errors.some((e) => e.field === "xdr")).toBe(true);
  });
});

describe("validateProposalAttachment — missing manifest references", () => {
  it("rejects a manifest attachment with no manifestReference", () => {
    const errors = validateProposalAttachment({ ...manifest(), manifestReference: "" }, 0);
    expect(errors.some((e) => e.field === "manifestReference")).toBe(true);
  });

  it("rejects a runbook attachment with no manifestReference", () => {
    const errors = validateProposalAttachment({ ...runbook(), manifestReference: "" }, 0);
    expect(errors.some((e) => e.field === "manifestReference")).toBe(true);
  });

  it("rejects a transaction_payload attachment with a whitespace-only manifestReference", () => {
    const errors = validateProposalAttachment(
      { ...transactionPayload(), manifestReference: "   " },
      0,
    );
    expect(errors.some((e) => e.field === "manifestReference")).toBe(true);
  });
});

describe("validateProposalAttachments — full list", () => {
  it("is valid when every attachment is valid", () => {
    const result = validateProposalAttachments([manifest(), runbook(), transactionPayload()]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("is invalid when any attachment is invalid, and indexes errors correctly", () => {
    const result = validateProposalAttachments([
      manifest(),
      { ...runbook(), manifestReference: "" },
      transactionPayload(),
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(1);
  });

  it("collects errors from multiple invalid attachments", () => {
    const result = validateProposalAttachments([
      { ...manifest(), sha256: "bad" },
      { ...transactionPayload(), xdr: undefined },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.index)).toEqual([0, 1]);
  });

  it("is invalid for an empty attachment list is still considered a valid (vacuous) list at the pure-function level", () => {
    // The route layer enforces "at least one attachment"; the pure validator
    // only checks the attachments it's given.
    const result = validateProposalAttachments([]);
    expect(result.valid).toBe(true);
  });
});

describe("accepted content types and size caps", () => {
  it("exposes exactly one accepted content type set per kind", () => {
    expect(ACCEPTED_ATTACHMENT_CONTENT_TYPES.manifest).toContain("application/json");
    expect(ACCEPTED_ATTACHMENT_CONTENT_TYPES.runbook).toContain("text/markdown");
    expect(ACCEPTED_ATTACHMENT_CONTENT_TYPES.transaction_payload).toContain("application/xdr");
  });

  it("caps transaction_payload attachments the smallest, since XDR envelopes are small", () => {
    expect(MAX_ATTACHMENT_SIZE_BYTES.transaction_payload).toBeLessThan(
      MAX_ATTACHMENT_SIZE_BYTES.manifest,
    );
    expect(MAX_ATTACHMENT_SIZE_BYTES.transaction_payload).toBeLessThan(
      MAX_ATTACHMENT_SIZE_BYTES.runbook,
    );
  });
});
