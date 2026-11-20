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
