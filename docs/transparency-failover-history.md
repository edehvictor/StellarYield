# Transparency failover history

The transparency API exposes failover incidents through
`GET /api/transparency/failover-history`, records incidents with
`POST /api/transparency/failover-history`, and resolves the newest open
incident for a protocol with
`POST /api/transparency/failover-history/:protocolId/resolve`.

Record requests require a non-empty `protocolId`, `protocolName`, and at least
one non-empty reason. Optional `startedAt` must be an ISO-8601 timestamp.
Resolution accepts an optional ISO-8601 `recoveredAt`, which must not predate
the incident start. Invalid input returns HTTP 400 and leaves the incident
history unchanged, so the caller can correct and retry the request.

For safe resolution retries after a lost response, send the same `recoveredAt`
value each time. Repeating a completed resolution with that timestamp returns
the already resolved incident and does not create or mutate another record.
When omitted, `recoveredAt` is assigned by the server, so clients that need
retry-safe completion should provide it.

The dashboard retries transient history reads up to three times and retains
its latest successful snapshot if all attempts fail. Failover history is
currently held in the server process memory; deployments requiring history to
survive process restarts should back this service with the configured database.
