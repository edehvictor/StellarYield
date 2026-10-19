# Governance Proposal Attachments

Governance proposals (see `client/src/pages/governance`) can reference operational
documents and transaction payloads alongside the admin action they propose. This
document describes the accepted attachment metadata and how it is validated.

## Attachment kinds

| Kind | Purpose | Accepted content type(s) | Max size |
|---|---|---|---|
| `manifest` | The deployment/registry manifest describing what is changing (see [deployment-manifest-provenance.md](../deployment-manifest-provenance.md)). | `application/json` | 256 KB |
| `runbook` | The operator runbook a reviewer should follow if the proposal needs to be rolled back or escalated. | `text/markdown`, `text/plain` | 512 KB |
| `transaction_payload` | The unsigned XDR envelope the proposal will submit on-chain once it clears multi-sig signing. | `application/xdr`, `text/plain` | 64 KB |

## Required metadata fields

Every attachment, regardless of kind, must include:

- `kind` — one of `manifest`, `runbook`, `transaction_payload`.
- `filename` — letters, numbers, dots, dashes, and underscores only (no path separators).
- `contentType` — must be one of the accepted content types for `kind`.
- `sizeBytes` — a positive number, at or below the per-kind size cap.
- `sha256` — a 64-character lowercase hex SHA-256 digest of the attachment content.
- `manifestReference` — identifies the proposal manifest this attachment belongs to
  (e.g. `deployment-manifest.json@a1b2c3d`). Required on every kind, not just
  `manifest` attachments, so a `runbook` or `transaction_payload` can always be
  traced back to the manifest describing the change it relates to.

`transaction_payload` attachments additionally require:

- `xdr` — the unsigned transaction XDR envelope. The server independently
  recomputes the SHA-256 digest of `xdr` and rejects the attachment if it does
  not match the submitted `sha256` — a client cannot claim a hash for content it
  did not actually submit.

The schema and pure validation functions live in
[`shared/types/governanceProposalAttachment.ts`](../../shared/types/governanceProposalAttachment.ts)
and are shared by the client (inline form validation) and the server (the
authoritative check).

## Client UI

`client/src/pages/governance/ProposalAttachments.tsx` lets a signer attach one or
more manifest / runbook / transaction-payload records to a proposal. Content is
pasted in directly and hashed client-side via the Web Crypto API
(`crypto.subtle.digest`), so the displayed SHA-256 is always derived from what was
actually typed. Validation errors are shown inline per field as the signer edits
each attachment, and the "Validate attachments" button stays disabled until every
attachment passes client-side validation — but it's never permitted to skip the
server round trip described below.

## Server validation

`POST /api/governance/proposals/attachments/validate`
(`server/src/routes/governance.ts`) is the authoritative check:

- Rejects an empty or missing `attachments` array, and caps a proposal at 20
  attachments.
- Runs the same `validateProposalAttachments` logic as the client against every
  attachment (unsupported `kind`, unsupported `contentType` for that `kind`,
  missing/oversized `sizeBytes`, malformed `sha256`, missing `manifestReference`,
  missing `xdr` on `transaction_payload` attachments).
- Recomputes the SHA-256 digest of `xdr` for every `transaction_payload`
  attachment and rejects the request if it doesn't match the submitted `sha256`.
- Responds `400` with `{ valid: false, errors: [...] }` (each error keyed by the
  attachment's index in the submitted array) if anything is invalid, or `200`
  with `{ valid: true, errors: [], attachments: [...] }` — including the
  confirmed filename/kind/sha256 for each attachment — once everything passes.

Invalid or malformed attachment metadata can never be submitted with a proposal
just because the client-side form allowed it through.

## Testing

- `shared/types/governanceProposalAttachment.ts` — pure validation logic, unit
  tested from `client/src/pages/governance/governanceProposalAttachment.test.ts`
  (valid attachments per kind, malformed metadata, missing manifest references).
- `server/src/__tests__/governanceProposalAttachments.test.ts` — integration
  tests against the live route (valid submissions, malformed metadata, missing
  manifest references, XDR/hash mismatch, oversized batches).
- `client/src/pages/governance/ProposalAttachments.test.tsx` — component tests
  covering inline validation errors, the computed SHA-256 display, the disabled
  submit state, and both success and server-rejection responses.
