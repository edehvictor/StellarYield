# Rejected Wallet Signature Recovery (#1363)

Wallet providers report a declined signature request in different, unstable
ways. StellarYield now reduces every signing failure to a shared, typed model so
the dashboard can recover without exposing raw provider text.

## Client flow

`shared/types/walletSignatureRejection.ts` classifies failures into:

| Code | Meaning | Retryable |
|---|---|---|
| `USER_REJECTED_SIGNATURE` | The user declined or dismissed the prompt. | yes |
| `WALLET_LOCKED` | The wallet needs to be unlocked. | yes |
| `WALLET_DISCONNECTED` | No wallet/app is connected or installed. | yes (after reconnect) |
| `WALLET_UNSUPPORTED` | The connected wallet cannot sign (e.g. smart-wallet session). | no |
| `SIGNING_TIMEOUT` | The wallet did not answer before the deadline. | yes |
| `MALFORMED_SIGNATURE_RESPONSE` | The wallet returned no usable signed XDR. | yes |
| `UNKNOWN_SIGNING_FAILURE` | Anything else, mapped to stable copy. | yes |

`useSignatureRecovery` tracks attempts (default limit: 3), exposes the typed
rejection, and reruns the caller's action through `retry()`. It does **not**
expose the provider's message. Once the limit is reached, `retry` is removed
from the actionable set and the copy recommends switching wallets.

`SignatureRejectionRecovery` renders the recovery panel with only the actions
the classifier allows: retry, reconnect, switch wallet, cancel. For multi-step
deposits it shows progress and the builder resumes at the failed vault, so a
retry never re-deposits into vaults that already succeeded.

Telemetry is best-effort. `reportSignatureRejection` posts the classified code
(never the raw reason) and cannot block or replace the local recovery UI when
the API is offline.

## API

`POST /api/wallet/signature-rejections`

```json
{
  "action": "portfolio_deposit",
  "walletAddress": "G…",
  "provider": "freighter",
  "code": "USER_REJECTED_SIGNATURE",
  "attempt": 1,
  "maxAttempts": 3,
  "completedSteps": 1,
  "totalSteps": 2
}
```

`201 Created`

```json
{
  "code": "USER_REJECTED_SIGNATURE",
  "title": "Signature request declined",
  "message": "Your wallet declined the signature request, so nothing was sent to the network.",
  "guidance": "Review the transaction, then retry and approve the signature request in your wallet.",
  "retryable": true,
  "attempt": 1,
  "maxAttempts": 3,
  "remainingAttempts": 2,
  "actions": ["retry", "switch_wallet", "cancel"],
  "recordedAt": "2026-10-21T08:00:00.000Z"
}
```

A raw `reason` may be supplied for classification by callers that do not
classify locally. It is never stored or echoed.

Malformed payloads return `400` with a stable code such as `INVALID_ACTION`
or `INVALID_REJECTION_CODE` and `details.fieldErrors`.

`GET /api/wallet/signature-rejections/summary?wallet=G…` returns aggregate
counts by code, the most common action, and the last occurrence. It returns a
zeroed summary with `200` when nothing has been recorded.

## Verification

- `shared/types/walletSignatureRejection.test.ts` — provider-specific
  classification, non-retryable wallets, attempt limits, no raw text leakage.
- `client/src/features/wallet/SignatureRejectionRecovery.test.tsx` — actions,
  progress, loading, exhausted attempts.
- `client/src/features/portfolio_builder/PortfolioBuilder.test.tsx` — retry
  resumes at the failed vault and does not duplicate successful deposits.
- `server/src/__tests__/walletSignatureRecovery.test.ts` — typed 400s, stable
  responses, summaries.
