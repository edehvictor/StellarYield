# Transparency failover history

The transparency API exposes failover incidents through
`GET /api/transparency/failover-history`, records incidents with
`POST /api/transparency/failover-history`, and resolves the newest open
incident for a protocol with
`POST /api/transparency/failover-history/:protocolId/resolve`.

Record requests require a JSON object body with a non-empty string
`protocolId`, `protocolName`, and at least one non-empty string reason.
Optional `startedAt` must be an ISO-8601 timestamp. Resolution accepts an
optional JSON object body with an ISO-8601 `recoveredAt`, which must not
predate the incident start. Optional `GET /api/transparency/failover-history?protocolId=<id>`
requires `protocolId` to be a single non-empty string when provided. Invalid
query parameters or payloads return HTTP 400 with a typed error `code`
(`INVALID_QUERY_PARAMETER` or `MALFORMED_INCIDENT_PAYLOAD`) and leave the
incident history unchanged, so the caller can correct and retry the request.

Every incident carries a `version` field, starting at `1` on creation and
incrementing on each mutation. Resolution accepts an optional `version` field
for optimistic concurrency control:

- If `version` is omitted, the resolve proceeds against the current open
  incident and increments its version.
- If `version` is provided and matches the incident's current version, the
  resolve proceeds and increments the version.
- If `version` is provided but does not match the current version (the state
  changed concurrently), the request returns HTTP 409 and no mutation occurs,
  so existing state is preserved and the caller can re-read and retry.

For safe resolution retries after a lost response, send the same `recoveredAt`
value each time. Repeating a completed resolution with that timestamp returns
the already resolved incident and does not create or mutate another record.
When omitted, `recoveredAt` is assigned by the server, so clients that need
retry-safe completion should provide it.

The dashboard retries transient history reads up to three times and retains
its latest successful snapshot if all attempts fail. Failover history is
currently held in the server process memory; deployments requiring history to
survive process restarts should back this service with the configured database.
