import { useMemo, useState } from "react";
import { Paperclip, CheckCircle, AlertTriangle, Hash, Trash2 } from "lucide-react";
import { apiUrl } from "../../lib/api";
import {
  PROPOSAL_ATTACHMENT_KINDS,
  ACCEPTED_ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_SIZE_BYTES,
  validateProposalAttachment,
  validateProposalAttachments,
  type ProposalAttachmentKind,
  type ProposalAttachmentInput,
  type ProposalAttachmentValidationError,
} from "../../../../shared/types/governanceProposalAttachment";

const KIND_LABELS: Record<ProposalAttachmentKind, string> = {
  manifest: "Manifest",
  runbook: "Runbook",
  transaction_payload: "Transaction payload",
};

interface AttachmentDraft {
  localId: string;
  kind: ProposalAttachmentKind;
  filename: string;
  /** Raw text content the user pasted in — JSON, markdown, or XDR depending on kind. */
  content: string;
  manifestReference: string;
  /** Computed asynchronously from `content` via Web Crypto. */
  sha256: string | null;
  hashing: boolean;
}

function newDraft(kind: ProposalAttachmentKind = "manifest"): AttachmentDraft {
  return {
    localId: crypto.randomUUID(),
    kind,
    filename: "",
    content: "",
    manifestReference: "",
    sha256: null,
    hashing: false,
  };
}

async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function draftToAttachment(draft: AttachmentDraft): Partial<ProposalAttachmentInput> {
  const attachment: Partial<ProposalAttachmentInput> = {
    kind: draft.kind,
    filename: draft.filename,
    contentType: ACCEPTED_ATTACHMENT_CONTENT_TYPES[draft.kind][0],
    sizeBytes: new TextEncoder().encode(draft.content).length,
    sha256: draft.sha256 ?? undefined,
    manifestReference: draft.manifestReference,
  };
  if (draft.kind === "transaction_payload") {
    attachment.xdr = draft.content;
  }
  return attachment;
}

function errorsFor(
  errors: ProposalAttachmentValidationError[],
  index: number,
  field: string,
): string | undefined {
  return errors.find((e) => e.index === index && e.field === field)?.message;
}

/**
 * Proposal attachment builder (issue #1033).
 *
 * Lets a signer attach manifest / runbook / transaction-payload metadata to
 * a governance proposal. Content is pasted in directly and hashed client-side
 * via Web Crypto so the SHA-256 digest — required before a transaction
 * payload can be submitted — is always derived from what was actually typed,
 * never hand-entered. Validation runs inline (this module's pure validators,
 * shared with the server) and again server-side on submit, since the server
 * is the only party that can be trusted to reject invalid metadata.
 */
export default function ProposalAttachments() {
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<
    { valid: true } | { valid: false; errors: ProposalAttachmentValidationError[] } | null
  >(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const candidateAttachments = useMemo(() => drafts.map(draftToAttachment), [drafts]);

  const localValidation = useMemo(
    () => validateProposalAttachments(candidateAttachments),
    [candidateAttachments],
  );

  const anyHashing = drafts.some((d) => d.hashing);
  const canSubmit =
    drafts.length > 0 && localValidation.valid && !anyHashing && !submitting;

  function updateDraft(localId: string, patch: Partial<AttachmentDraft>) {
    setDrafts((prev) => prev.map((d) => (d.localId === localId ? { ...d, ...patch } : d)));
    setSubmitResult(null);
  }

  function addAttachment() {
    setDrafts((prev) => [...prev, newDraft()]);
    setSubmitResult(null);
  }

  function removeAttachment(localId: string) {
    setDrafts((prev) => prev.filter((d) => d.localId !== localId));
    setSubmitResult(null);
  }

  async function handleContentChange(localId: string, content: string) {
    updateDraft(localId, { content, sha256: null, hashing: content.length > 0 });
    if (!content) return;
    const hash = await sha256Hex(content);
    setDrafts((prev) =>
      prev.map((d) => (d.localId === localId && d.content === content ? { ...d, sha256: hash, hashing: false } : d)),
    );
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    setSubmitResult(null);
    try {
      const res = await fetch(apiUrl("/api/governance/proposals/attachments/validate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachments: candidateAttachments }),
      });
      const body = await res.json();
      if (!res.ok || body.valid === false) {
        setSubmitResult({ valid: false, errors: body.errors ?? [] });
        return;
      }
      setSubmitResult({ valid: true });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not reach the server to validate attachments");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="glass-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <Paperclip size={18} /> Proposal Attachments
        </h3>
        <button
          type="button"
          onClick={addAttachment}
          className="btn-secondary px-3 py-1.5 text-sm"
        >
          Add attachment
        </button>
      </div>

      {drafts.length === 0 && (
        <p className="text-sm text-gray-500">
          Attach the manifest, runbook, or transaction payload this proposal references. Each
          attachment must include a manifest reference so reviewers can trace it back to the
          change being proposed.
        </p>
      )}

      <div className="space-y-4">
        {drafts.map((draft, index) => {
          const attachmentErrors = localValidation.errors.filter((e) => e.index === index);
          const isValid = attachmentErrors.length === 0 && draft.content.length > 0;
          return (
            <div
              key={draft.localId}
              className="border border-gray-700 rounded-lg p-4 space-y-3 bg-[#1a1a2e]/50"
            >
              <div className="flex items-center justify-between gap-3">
                <select
                  aria-label={`Attachment ${index + 1} kind`}
                  value={draft.kind}
                  onChange={(e) =>
                    updateDraft(draft.localId, {
                      kind: e.target.value as ProposalAttachmentKind,
                    })
                  }
                  className="bg-[#1a1a2e] border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm"
                >
                  {PROPOSAL_ATTACHMENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Remove attachment ${index + 1}`}
                  onClick={() => removeAttachment(draft.localId)}
                  className="text-gray-500 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Filename</label>
                <input
                  type="text"
                  value={draft.filename}
                  onChange={(e) => updateDraft(draft.localId, { filename: e.target.value })}
                  placeholder={
                    draft.kind === "manifest"
                      ? "deployment-manifest.json"
                      : draft.kind === "runbook"
                        ? "emergency-runbook.md"
                        : "set-keeper-fee.xdr"
                  }
                  className="w-full bg-[#1a1a2e] border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
                />
                {errorsFor(localValidation.errors, index, "filename") && (
                  <p className="text-xs text-red-400 mt-1">
                    {errorsFor(localValidation.errors, index, "filename")}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Manifest reference</label>
                <input
                  type="text"
                  value={draft.manifestReference}
                  onChange={(e) =>
                    updateDraft(draft.localId, { manifestReference: e.target.value })
                  }
                  placeholder="deployment-manifest.json@<commit>"
                  className="w-full bg-[#1a1a2e] border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
                />
                {errorsFor(localValidation.errors, index, "manifestReference") && (
                  <p className="text-xs text-red-400 mt-1">
                    {errorsFor(localValidation.errors, index, "manifestReference")}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  {draft.kind === "transaction_payload" ? "XDR" : "Content"}
                </label>
                <textarea
                  value={draft.content}
                  onChange={(e) => void handleContentChange(draft.localId, e.target.value)}
                  rows={draft.kind === "transaction_payload" ? 3 : 5}
                  placeholder={
                    draft.kind === "manifest"
                      ? '{"version": "1.0.0", ...}'
                      : draft.kind === "runbook"
                        ? "# Runbook\n..."
                        : "AAAAAgAAAAB..."
                  }
                  className="w-full bg-[#1a1a2e] border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono"
                />
                {draft.kind === "transaction_payload" &&
                  errorsFor(localValidation.errors, index, "xdr") && (
                    <p className="text-xs text-red-400 mt-1">
                      {errorsFor(localValidation.errors, index, "xdr")}
                    </p>
                  )}
                {errorsFor(localValidation.errors, index, "contentType") && (
                  <p className="text-xs text-red-400 mt-1">
                    {errorsFor(localValidation.errors, index, "contentType")}
                  </p>
                )}
                {errorsFor(localValidation.errors, index, "sizeBytes") && (
                  <p className="text-xs text-red-400 mt-1">
                    {errorsFor(localValidation.errors, index, "sizeBytes")}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 text-xs">
                <Hash size={12} className="text-gray-500" />
                {draft.hashing ? (
                  <span className="text-gray-500">Hashing…</span>
                ) : draft.sha256 ? (
                  <span className="font-mono text-gray-400 break-all">{draft.sha256}</span>
                ) : (
                  <span className="text-gray-600">SHA-256 will appear once content is entered</span>
                )}
              </div>

              <div className="flex items-center gap-1.5 text-xs">
                {isValid ? (
                  <>
                    <CheckCircle size={14} className="text-green-400" />
                    <span className="text-green-400">Attachment is valid</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={14} className="text-amber-400" />
                    <span className="text-amber-400">
                      {attachmentErrors.length > 0
                        ? `${attachmentErrors.length} field${attachmentErrors.length === 1 ? "" : "s"} need attention`
                        : "Content is required"}
                    </span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {drafts.length > 0 && (
        <div className="pt-2 border-t border-gray-700 space-y-3">
          {submitError && <p className="text-sm text-red-400">{submitError}</p>}

          {submitResult && !submitResult.valid && (
            <div className="border border-red-500/30 bg-red-500/5 rounded-lg p-3">
              <p className="text-sm font-medium text-red-300 mb-1">
                Server rejected these attachments
              </p>
              <ul className="text-xs text-red-400 space-y-0.5">
                {submitResult.errors.map((err, idx) => (
                  <li key={idx}>
                    • Attachment {err.index + 1}: {err.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {submitResult?.valid && (
            <div className="border border-green-500/30 bg-green-500/5 rounded-lg p-3 flex items-center gap-2">
              <CheckCircle size={16} className="text-green-400" />
              <p className="text-sm text-green-300">
                Attachments validated. They can be included with this proposal.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold py-2.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {submitting ? "Validating…" : "Validate attachments"}
          </button>
        </div>
      )}
    </div>
  );
}
