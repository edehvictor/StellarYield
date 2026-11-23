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
