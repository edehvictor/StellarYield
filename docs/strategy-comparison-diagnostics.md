# Strategy comparison diagnostics (#1925)

Comparison failures expose a controlled code, stage, message, remediation and retryable flag. Raw transport and execution exception messages are not returned as diagnostics. Version conflicts retain the existing current-state and version response contract; those state fields are application data, not diagnostic logging fields.

Validation failures require corrected input. Confirmed version conflicts may be retried against freshly fetched state. An ambiguous transport or execution failure requires reconciliation before another mutation; retryable does not mean automatically retry every failure.

The in-memory comparison service restores its previous state, allocation balances and version when a synchronous side effect throws. Failed operations are not recorded as successful idempotent operations. This does not guarantee reversal of external transactions or durable cross-process atomicity.

Yield reads validate assumptions and supplied configuration fingerprints before fetching data. Stale configuration returns HTTP 409 and the current fingerprint. Refresh configuration before retrying. The client filters malformed yield rows and preserves existing displayed comparisons on failed refreshes.

Regression coverage includes normal operation, validation failure, execution rollback, diagnostic redaction and safe retry.
