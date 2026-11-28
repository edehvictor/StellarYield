# Wallet lifecycle diagnostics

Wallet connection failures are reported with a stable lifecycle stage and a
remediation hint. Diagnostics deliberately exclude wallet addresses, login
identifiers, provider error text, transaction payloads, and session secrets.
The connection dialog displays the same privacy-safe guidance that is written
to the console.

Connection and smart-wallet input validation complete before the current
session is replaced. A failed authorization, address validation, or storage
write therefore leaves the previously persisted wallet session unchanged;
users can retry after following the remediation hint. Transaction signing
failures are also normalized so provider-specific error details are not
surfaced by the wallet context.

Smart-wallet backend verification remains best-effort: when the verification
service is unavailable or returns insufficient context, the wallet can connect
in degraded local-only mode. The diagnostic identifies verification as the
failed stage and recommends retrying verification when the service is
available.

## Stale wallet auth configuration snapshots

Smart-wallet challenge/verify flows are bound to an immutable wallet auth
configuration fingerprint (`authConfigFingerprint`) derived from the current
challenge/verification policy snapshot (challenge format/version, expiry policy,
and accepted signer policy). The fingerprint is returned by
`POST /api/auth/challenge`, embedded in the issued challenge, and must match the
server's current configuration during `POST /api/auth/verify`.

When a challenge or session snapshot no longer matches the current
configuration, verification is rejected with `409` and
`code: STALE_WALLET_AUTH_CONFIG` (including `currentAuthConfigFingerprint`).
Stale or mismatched snapshots are rejected before replay/consume side effects so
clients can safely refresh work by requesting a fresh challenge and retrying
verification.

On validation or execution failure (including stale-config rejection, refresh
failures, or unavailable verification backends), the wallet lifecycle preserves
existing persisted session state/balances where applicable: failed connect
validation does not replace a previously stored session, and recovery/session
verification failures keep the restored session in a degraded, retryable state
rather than discarding it. Verified smart-wallet sessions persist the bound
`authConfigFingerprint` so stale snapshots can be detected and refreshed on
subsequent lifecycle operations.

## Session and challenge boundary semantics (#1882)

- Client: a session whose age equals `SESSION_TTL_MS` is still valid and expires 1ms later. Idle time equal to `STALE_THRESHOLD_MS` is still fresh. Future timestamps (clock skew) are clamped to zero age. An unparseable `connectedAt` or `lastActivityAt` fails closed (expired / stale). Checks are pure and never mutate the session, so retrying is safe.
- Server: an auth challenge is valid through its expiry instant (inclusive) and is rejected if its expiry is more than the 5 minute challenge TTL in the future ("Challenge expiry is outside the allowed window."). Rejected challenges are not consumed by the replay cache.

## Duplicate submissions and safe retries (#1880)

Every wallet lifecycle operation that has an effect carries an operation
identity so a duplicate submission cannot apply that effect twice.

**Server: `POST /api/auth/verify`**

- Accepts an optional operation identity as the `operationId` body field or the
  `Idempotency-Key` header (8–128 characters of `A-Z a-z 0-9 . _ : -`). If both
  are sent they must match, otherwise the request is rejected with
  `400 INVALID_WALLET_OPERATION_ID` before any side effect.
- On the first successful verification the outcome is recorded against the
  identity, together with a fingerprint of the request (wallet, session key,
  challenge, signature). Records are kept for the 5 minute challenge TTL.
- A retry with the same identity and identical payload returns the recorded
  outcome with `replayed: true`. The challenge is consumed only once, and
  this check runs before the expiry and replay checks, so a retry after a lost
  response still succeeds.
- Reusing an identity for a different payload is rejected with
  `409 WALLET_OPERATION_CONFLICT` and applies nothing.
- Validation errors, stale-config rejections and bad signatures are never
  recorded and consume nothing, so the same operation can simply be retried.
- Without an operation identity the behaviour is unchanged: a second
  submission of a consumed challenge is rejected with
  "Challenge has already been used."

**Client: `client/src/auth/session.ts`**

- Each challenge verification gets a fresh `operationId`
  (`createWalletOperationId()`), which is sent in the body and as
  `Idempotency-Key`. Network failures and `5xx` responses are retried once with
  the exact same body and identity (`VERIFY_SAFE_RETRY_ATTEMPTS`). `4xx`
  responses are not retried.
- `connectWalletSession()` is single-flight per connect operation key
  (provider + normalised identifier, see `getConnectOperationKey()`). Duplicate
  submissions such as double clicks share one in-flight operation: the wallet is
  prompted once, one session key is generated, one verification runs, the
  session is persisted once, and every caller receives the same session. Once
  the operation settles, the next call starts a fresh attempt.
- `recoverSession()` is single-flight too, so a double-mounted effect probes
  the provider and re-verifies only once.
- A failed connect, including one shared by duplicate submissions, never
  replaces the previously persisted session.
