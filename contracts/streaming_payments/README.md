# Streaming Payments

Soroban contract for continuous token streams. A sender escrows a fixed token
amount between a start and end ledger timestamp. The recipient can withdraw the
unlocked amount over time, while the sender can cancel the stream and reclaim
the unvested balance.

Public entrypoints:

- `create_stream(sender, recipient, token, amount, start_time, end_time)`
- `withdraw_from_stream(recipient, stream_id)`
- `cancel_stream(sender, stream_id)`
- `withdrawable(stream_id)`
- `get_stream(stream_id)`

The contract uses integer math:

```text
unlocked = amount * elapsed_seconds / total_duration_seconds
```

This gives deterministic block-by-block unlocking based on the current ledger
timestamp. Withdrawals set a per-stream lock before token transfer to reject
re-entrant withdrawal attempts.
