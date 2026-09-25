# Keeper Operational Limits — Redis Backing

This document describes operational limits for the Redis-backed keeper queue
infrastructure. Treat these as guardrails rather than hard ceilings.

## 1. General Limits

- Connection lifetime: the shared Redis client is created lazily and reused for
  the process lifetime.
- Reconnect behavior: ioredis reconnects automatically; backoff is controlled by
  the client options.
- Max retries per request: `null`, required for BullMQ.
- Ready check: disabled (`enableReadyCheck: false`) to favor availability during
  failover.

## 2. Job Attempts and Backoff

- Default max attempts: `config.keeper.jobMaxAttempts` (default 5).
- Backoff type: exponential.
- Backoff delay: 5s base.
- Retry budget: exhausted after `jobMaxAttempts` attempts. Non-retryable errors
  bypass retries and move directly to the poison queue.

## 3. Poison Queue Limits

- Poison queue name: `poison`.
- No automatic retries for poison jobs (`attempts: 0`).
- Keep policy: retain recent failures for operator review
  (`removeOnComplete.count`, `removeOnFail.count`).
- Threshold warning: `QUEUE_POISON_THRESHOLD` (default 5). Exceeding this
  threshold triggers health warnings.

## 4. Sequence Coordination and Fencing

- Required sequence is pinned at job creation.
- Workers fetch the current account sequence before submission.
- Sequence mismatch is non-retryable and triggers quarantine.
- Fencing tokens are monotonic per target (account or vault). A mismatch means
  a newer job exists; stale jobs are rejected.

## 5. Degraded Redis and Outage Behavior

- `getRedisConnectionStatus()` returns:
  - `healthy`: ping latency <= 1000 ms.
  - `degraded`: ping latency > 1000 ms or transient failures.
  - `outage`: ping fails or Redis unreachable.
- Queue health degrades when Redis is not healthy.
- BullMQ workers will backoff and retry according to BullMQ’s internal retry
  policy during Redis issues.

## 6. Monitoring Guidance

- Emit metrics for:
  - Queue health (`getQueueHealth`) including poison counts.
  - Redis latency and connection status.
  - Job lifecycle transitions: created, claimed, submitted, confirmed, failed,
    exhausted.
- Alert on:
  - Rising poison counts.
  - Persistent `outage` or `degraded` Redis status.
  - Repeated fencing violations or sequence mismatches.

## 7. Operational Runbook

1. If `outage` persists, restart keepers after confirming Redis is reachable.
2. If poison counts spike, review `_poisonReason` in quarantine jobs.
3. For fencing violations, verify producer is advancing tokens correctly.
4. For sequence mismatches, check RPC seqno drift and retry submission with a
   fresh required sequence.