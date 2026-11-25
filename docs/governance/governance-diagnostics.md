# Governance Failure Diagnostics

Governance actions span several stages: request validation, impact forecasting,
quorum evaluation, attachment validation, proposal transaction build, wallet
signing, network submission, and confirmation. When one of those stages fails,
the governance interface must say **which stage failed** and **what to do next**
without exposing wallet addresses, transaction XDR, RPC endpoints, or raw stack
traces.

The canonical types and builders live in
[`shared/types/governanceDiagnostic.ts`](../../shared/types/governanceDiagnostic.ts)
and are imported by both the server routes and the client governance UI, so a
stage is named identically on both sides.

## Diagnostic shape

| Field | Meaning |
| :--- | :--- |
| `code` | Stable machine-readable identifier: `CONTEXT_INSUFFICIENT`, `VALIDATION_FAILED`, `STAGE_UNAVAILABLE`, `STATE_PRESERVED`, or `RETRY_UNSAFE`. |
| `stage` | The governance stage that was reached but not completed. |
| `severity` | `info`, `warning`, or `critical`. |
| `summary` | One fixed, operator-facing sentence. Never contains a submitted value. |
| `remediation` | The single next action, phrased as something to do. |
| `retryable` | Whether repeating the same request is safe. |
| `privacySafe` | Literal `true`; consumers can assert the guarantee. |
| `affectedStages` | Optional stable stage identifiers, never raw values. |

Stages: `request-validation`, `forecast`, `quorum`, `attachments`,
`proposal-build`, `wallet-signing`, `submission`, `confirmation`, and
`state-persistence`.

Every failure response includes the primary diagnostic followed by a
`STATE_PRESERVED` diagnostic, because no governance route writes proposal,
signature, or balance state before validating.

## Server behaviour

Affected endpoints in `server/src/routes/governance.ts`:

- `POST /api/governance/forecast`
- `POST /api/governance/quorum-progress`
- `POST /api/governance/proposals/attachments/validate`

A failure body keeps the legacy `error` / `message` fields and adds:

```json
{
  "error": "VALIDATION_FAILED",
  "message": "The governance request was rejected during validation, before any state-changing step.",
  "stage": "request-validation",
  "retryable": false,
  "fields": ["proposalType", "baseline"],
  "diagnostics": [
    { "code": "VALIDATION_FAILED", "stage": "request-validation", "...": "..." },
    { "code": "STATE_PRESERVED", "stage": "state-persistence", "...": "..." }
  ]
}
```

`fields` lists only field **names** that failed validation. Submitted values,
attachment content, XDR, and wallet addresses are never echoed.

Unexpected exceptions inside a stage are caught and returned as
`STAGE_UNAVAILABLE` with a fixed summary. The thrown error is not returned to
the caller; it belongs in server logs only.

Malformed attachment metadata (non-string `xdr`, `manifestReference`, `sha256`,
and so on) is reported as `VALIDATION_FAILED` against the offending field
instead of producing an opaque 500.

## State preservation and safe retry

- All three endpoints are read-only. A failed request cannot partially apply a
  proposal, signature, or balance change.
- Validation failures have `retryable: false` because the request must be
  corrected first; the `remediation` text says what to correct.
- Stage failures have `retryable: true`; retrying the same request is safe once
  the stage recovers.
- `RETRY_UNSAFE` is reserved for failures after the request may have reached the
  network (for example polling for confirmation). Check the transaction hash or
  proposal status before retrying.

## Client behaviour

`client/src/pages/governance/governanceDiagnostics.ts` maps UI failures to the
same shared builder:

- `TransactionBuilder` attributes build/simulation failures to
  `proposal-build` and tracks the exact failed timeline phase (`building` vs
  `simulating`). The selected action and entered field values are retained on
  failure so the signer can retry without retyping.
- `PendingTransactionCard` attributes co-sign failures to `wallet-signing`,
  submission failures to `submission`, and confirmation failures to
  `confirmation` with `RETRY_UNSAFE`.
- `GovernanceDiagnosticsList` renders the stage label, code, summary, and
  `Next:` remediation inline with the existing transaction timeline.

`areGovernanceDiagnosticsPrivacySafe` can be used by tests or component
assertions to verify that every rendered diagnostic satisfies the privacy
guarantee.

## Tests

- `server/src/__tests__/governanceDiagnostics.test.ts` — normal operation,
  validation failure, unexpected stage failure with no raw error leakage,
  malformed attachment handling, and safe retry after failure.
- `client/src/pages/governance/governanceDiagnostics.test.ts` — stage
  attribution and retry-safety mapping.
- `client/src/pages/governance/governanceProposalAttachment.test.ts` — existing
  attachment metadata coverage, including the hardened non-string field checks.

## Related documentation

- [`docs/governance-boundary-calculations.md`](../governance-boundary-calculations.md) — Boundary-value calculations, checked arithmetic, rounding policies, and state preservation invariants (#1898).
- [`docs/governance/proposal-attachments.md`](proposal-attachments.md) — Proposal attachment metadata validation and integrity checks.
