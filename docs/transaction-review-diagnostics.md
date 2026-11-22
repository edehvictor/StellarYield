# Transaction review diagnostics

Closes the gap described in #1893: a failed transaction review used to return a
bare error string (and, for 500s, the raw exception message), so neither users
nor operators could tell which stage failed, what to do next, or whether a retry
was safe.

## Contract

Shared by server and client in
[`shared/types/transactionReviewDiagnostic.ts`](../shared/types/transactionReviewDiagnostic.ts).

| Field | Meaning |
| --- | --- |
| `code` | `VALIDATION_FAILED`, `STAGE_UNAVAILABLE`, `QUOTE_REFRESH_REQUIRED`, `RETRY_UNSAFE`, `CONTEXT_INSUFFICIENT`, `STATE_PRESERVED` |
| `stage` | `request-validation`, `quote`, `quote-verification`, `wallet-signing`, `submission`, `confirmation`, `state-persistence`, `unknown` |
| `summary` / `remediation` | Fixed-template text; the next action to take |
| `retryable` | Whether repeating the same request is safe |
| `privacySafe` | Always `true`; text never contains raw errors, addresses, URLs, hashes or paths |

Every failure response carries the failed-stage diagnostic first, followed by a
`STATE_PRESERVED` entry: reviewing a quote is read-only, so balances, quotes and
signed transactions are never modified by a failure.

### Immutable configuration snapshots

Transaction review quotes are bound to an immutable asset-configuration snapshot
fingerprint (`assetConfigVersion`, also surfaced as `X-Config-Version` on quote
responses) and, when present, a cryptographic assumption fingerprint over the
quoted review assumptions. Verification rejects stale or untrusted snapshots
(`STALE_QUOTE`, `CONFIG_DRIFT`, `ASSUMPTION_DRIFT`, `INVALID_FINGERPRINT`)
before any balances or signed state can change, so the client can safely
refresh/re-quote and retry review without reusing stale work.

## Server behaviour (`/api/zap/*`)

| Route | Failure | Stage | Code |
| --- | --- | --- | --- |
| `POST /quote` | `MISSING_FIELDS`, `INVALID_AMOUNT` (400) | `request-validation` | `VALIDATION_FAILED` |
| `POST /quote` | `QUOTE_FAILED` (500, `recoverable: true`) | `quote` | `STAGE_UNAVAILABLE` |
| `POST /verify` | `STALE_QUOTE`, `CONFIG_DRIFT`, `ASSUMPTION_DRIFT`, `INVALID_FINGERPRINT` (stale/untrusted config or assumption snapshot) | `quote-verification` | `QUOTE_REFRESH_REQUIRED` |
| `POST /verify` | `INVALID_QUOTE`, `ROUTE_MISMATCH`, `UNSUPPORTED_ASSET`, `SLIPPAGE_EXCEEDED` | `quote-verification` | `VALIDATION_FAILED` |
| `POST /verify`, `/fingerprint` | unexpected exception (500) | `quote-verification` | `STAGE_UNAVAILABLE` |
| `POST /fingerprint` | invalid body (400) | `request-validation` | `VALIDATION_FAILED` |

**Behaviour change:** 500 responses from these routes no longer include the raw
exception message in `details`. Use the `requestId`/server logs to investigate.
Stale or untrusted snapshot failures are recoverable and should trigger a fresh
quote/review; unknown verify codes degrade to `CONTEXT_INSUFFICIENT` instead of
guessing. Verification is read-only and preserves balances, quotes, and signed
transactions.

## Client behaviour

- `ZapQuoteError.diagnostics` holds diagnostics parsed from the response.
  `parseTransactionReviewDiagnostics` drops malformed entries and rebuilds text
  from templates, so a hostile or malformed body cannot inject text into the UI.
- `TransactionReviewModal` accepts a `diagnostics` prop. If `error` is set and no
  diagnostics are supplied, it shows a `CONTEXT_INSUFFICIENT` diagnostic so the
  user still gets a remediation path. Confirm stays disabled while an error is
  shown and re-enables once it clears, so retrying is safe.
- `buildExecutionDiagnostics` marks failures at or after submission as
  `RETRY_UNSAFE`: the transaction may already be on the network, so check its
  status before retrying. Failures during signing are safe to retry.

## Tests

- `shared/types/transactionReviewDiagnostic.test.ts`
- `server/src/__tests__/transactionReviewDiagnostics.test.ts`
- `client/src/components/transaction/TransactionReviewModal.test.tsx` (`diagnostics (#1893)`)
