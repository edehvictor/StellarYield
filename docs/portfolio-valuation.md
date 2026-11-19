# Portfolio valuation retries

PnL valuation is a read-only replay of the persisted `UserTransaction` and
`SharePriceSnapshot` history. It does not update portfolio balances or consume
the source records, so a failed request can be retried from the same history.
Any temporary calculation state is local to that request and is discarded on
failure.

Before replay, the service validates every transaction and price snapshot and
checks that withdrawals, swaps, and fees do not exceed the replayed share
balance. Invalid or incomplete history returns `422` with a failure stage and
a remediation hint; the source history must be corrected or completed before
retry. If the current share price is not available, the endpoint returns
`503` instead of inventing a fallback valuation. A transient calculation
failure returns `500` and can be retried without changing balances.

The endpoint reports no partial valuation. Transaction order is deterministic
for equal timestamps, and validation happens before the calculation mutates any
working cost-basis state.
