# Transparency status: network, ledger and version binding (#1916)

Transparency status is read from a Stellar network at some ledger. Without
that context a dashboard could show mainnet figures on a testnet build after a
data source is repointed, or replace a fresh snapshot with an older one when a
request lands on an RPC node that is behind. Every transparency read and write
is now bound to an explicit context, and mismatches are refused.

The shared definition is `shared/types/transparencyContext.ts`.

## Context

```json
{ "network": "testnet", "ledger": 5000, "version": "1" }
```

| Field | Meaning |
| --- | --- |
| `network` | `mainnet`, `testnet`, `futurenet` or `local` |
| `ledger` | Ledger sequence the snapshot reflects |
| `version` | Payload schema version (`TRANSPARENCY_SCHEMA_VERSION`, currently `"1"`) |

### Server network

The server reads its network from `NETWORK_PASSPHRASE`,
`STELLAR_NETWORK_PASSPHRASE` or `STELLAR_NETWORK` (passphrase or label), the
same variables as the metrics network label. Unset means `testnet`, matching
the client's default passphrase. A value that is set but not a known network
fails the request with `INVALID_TRANSPARENCY_CONTEXT` instead of guessing.

### Snapshot ledger

A data source may report `ledger` and `network` next to `history`. A reported
network must equal the server's, or the read fails with
`TRANSPARENCY_NETWORK_MISMATCH` and nothing is cached. A source that reports no
ledger (the seeded data) is stamped with a clock estimate (one ledger per five
seconds), which only ever moves forward.

## Reads

`GET /api/transparency/summary` (and `GET /api/transparency`)

The response adds `context` and the headers `X-Stellar-Network`, `X-Ledger` and
`X-Transparency-Version`.

A reader states what it expects with query parameters or headers:

| Query | Header | Check |
| --- | --- | --- |
| `network` | `X-Stellar-Network` | Must equal the snapshot's network |
| `version` | `X-Transparency-Version` | Must equal the schema version |
| `minLedger` | `X-Min-Ledger` | Snapshot ledger must be at least this |

| Status | `code` | `retryable` | When |
| --- | --- | --- | --- |
| 400 | `INVALID_TRANSPARENCY_CONTEXT` | false | An expectation is present but malformed |
| 409 | `TRANSPARENCY_NETWORK_MISMATCH` | false | Reader expects another network |
| 409 | `TRANSPARENCY_VERSION_MISMATCH` | false | Reader expects another schema |
| 409 | `TRANSPARENCY_LEDGER_BEHIND` | true | The newest snapshot is older than `minLedger` |

A 409 body carries the server's `context`, never the figures.

When `minLedger` is ahead of the cached snapshot, the server reads the source
once more before answering.

### Cache rules

- A snapshot from an older ledger never replaces a newer one. The newer
  snapshot is kept and served.
- A snapshot cached for one network is discarded when the server's network
  changes and is never served, not even as the fallback after a failed read.
- A failed read still falls back to the last good snapshot for the same
  network, subject to the reader's expectations.

`GET /api/transparency/failover-history` adds `context: { network, version }`
and honours `network` and `version` the same way. Incident history is not tied
to a ledger, so `minLedger` is not checked there.

## Writes

`POST /api/transparency/failover-history` and
`POST /api/transparency/failover-history/:protocolId/resolve` accept the
network in `X-Stellar-Network` or body `network`. A write naming another
network gets `409 TRANSPARENCY_NETWORK_MISMATCH` and records nothing. A write
that names no network is accepted as before.

## Client

`client/src/pages/transparency/transparencyContextClient.ts`:

- `getExpectedTransparencyNetwork()` derives the network from
  `VITE_NETWORK_PASSPHRASE` (testnet by default).
- Every summary request sends `network`, `version` and, once a snapshot is
  shown, `minLedger` = its ledger.
- `readTransparencySummaryResponse` accepts a response only when its context
  matches the expected network and version and its ledger is not older than
  the one shown. Otherwise it returns `keep-current`.

The dashboard keeps the snapshot on screen whenever an update is refused,
shows why, and shows the network and ledger of the figures it displays. A
`TRANSPARENCY_LEDGER_BEHIND` answer is retried twice (after 300 ms and
600 ms). Switching networks needs a reload, never a response. A response with
no `context` (an older server) is accepted but leaves the snapshot unbound.

## Tests

- `shared/types/transparencyContext.test.ts`
- `server/src/__tests__/transparencyContextBinding.test.ts`
- `client/src/pages/transparency/transparencyContextClient.test.ts`
- `client/src/pages/transparency/TransparencyDashboard.test.tsx` (#1916 block)
