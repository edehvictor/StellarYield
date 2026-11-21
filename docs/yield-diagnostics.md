# Yield data diagnostics

When the yield data display cannot show rates, it tells the user **which step
failed** and **what to do next**, without exposing internals. The contract is
defined once in [`shared/types/yieldDiagnostics.ts`](../shared/types/yieldDiagnostics.ts)
and used by both the server (`GET /api/yields`) and the client
(`ApyDashboard` → `YieldDiagnosticNotice`). Introduced in #1877.

## Response shape

A failed `GET /api/yields` keeps the legacy error fields and adds `diagnostic`:

```json
{
  "error": "YIELD_FETCH_FAILED",
  "message": "Unable to fetch yield data right now.",
  "requestId": "3f1c2a9e-1b2c-4d5e-8f90-123456789abc",
  "recoverable": true,
  "diagnostic": {
    "code": "YIELD_RELIABILITY_UNAVAILABLE",
    "stage": "reliability_scoring",
    "stageKnown": true,
    "summary": "Yield data was loaded, but its freshness and reliability could not be verified.",
    "remediation": "Retry shortly. Rates are withheld rather than shown without a health check.",
    "retryable": true,
    "requestId": "3f1c2a9e-1b2c-4d5e-8f90-123456789abc"
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `code` | string | Stable diagnostic code (table below) |
| `stage` | string | Processing stage that failed |
| `stageKnown` | boolean | `false` only when the stage could not be determined |
| `summary` | string | Safe explanation of what failed |
| `remediation` | string \| null | Suggested next step; `null` when there is not enough evidence for one |
| `retryable` | boolean | Whether repeating the same request unchanged can succeed |
| `requestId` | string? | Correlation id (matches the `X-Request-Id` header); omitted if unavailable or not a safe opaque token |

Status codes: `400` for `input_validation` (with `error: "VALIDATION_FAILED"`
and `details.invalidParameters`, a list of parameter **names**), `500` for
every other server stage. Failure responses are sent with
`Cache-Control: no-store`. Successful responses are unchanged.

## Stages and codes

Stages follow the handler's real execution order. Each stage has exactly one
code.

| Stage | Code | Where | Retryable | Typical remediation |
|---|---|---|---|---|
| `input_validation` | `YIELD_INPUT_INVALID` | Server: `protocolFeeBps`, `vaultFeeBps`, `rebalanceCostBps`, `slippageBps` query parameters | No | Reset fee assumptions or use values in 0–10000 bps |
| `source_retrieval` | `YIELD_SOURCE_UNAVAILABLE` | Server: `getYieldDataWithCacheStatus` (network snapshot, protocol data, cache) | Yes | Retry; check network status / Diagnostics panel |
| `reliability_scoring` | `YIELD_RELIABILITY_UNAVAILABLE` | Server: `yieldReliabilityEngine.calculateReliabilityScore` | Yes | Retry shortly |
| `yield_enrichment` | `YIELD_ENRICHMENT_FAILED` | Server: `calculateNetYield`, `getFeeHistory` | Yes | Retry or reset custom fee assumptions |
| `response_serialization` | `YIELD_SERIALIZATION_FAILED` | Server: encoding the JSON body | Yes | Retry; report with the request id |
| `network` | `YIELD_NETWORK_UNREACHABLE` | Client: no HTTP response (offline, DNS, CORS, abort) | Yes | Check connection and retry |
| `response_parsing` | `YIELD_RESPONSE_MALFORMED` | Client: a 2xx body that is not a list, or client-side row processing threw | Yes | Reload the app; report with the request id |
| `unknown` | `YIELD_STAGE_UNKNOWN` | Either side: the stage cannot be determined | Yes | **None** (see below) |

The server attributes a failure by tagging the error where it is thrown
(`inStage(stage, fn)` in `server/src/routes/yields.ts`), not through a shared
"current stage" variable. This keeps attribution correct even though yield
entries are processed concurrently. An error thrown outside every tagged
stage is reported as `unknown`.

## Insufficient or malformed context: fallback behaviour

The client resolves whatever it receives with `resolveYieldDiagnostic`, which
never throws:

1. a recognised `diagnostic.code` → that code's catalog entry;
2. otherwise a recognised `diagnostic.stage` → that stage's entry (partial
   diagnostics are completed from the catalog);
3. otherwise the transport context: no response → `network`; a 2xx body with
   the wrong shape → `response_parsing`;
4. otherwise → `unknown`.

The `unknown` diagnostic is explicit: the UI shows *"Failed step: Could not be
determined"*, offers **no remediation**, and points the user to support with
the reference id. Legacy `{ error, message }` bodies, `null` or missing
diagnostics, non-JSON bodies (e.g. a proxy's HTML 502 page), unknown codes and
fields of the wrong type all take this path. The display never falls back to
an empty "no protocols" state or a raw exception.

A failed refresh **keeps the rates already on screen** and shows the
diagnostic as a banner ("Live APY refresh failed. Showing the last available
rates."). The full-page notice is only used when nothing has loaded yet.

## Privacy

- User-facing copy comes only from the shared catalog. The client never
  renders `message`, `summary`, `remediation`, `stack` or any other free text
  from a response body, so a misbehaving server or proxy cannot leak internals
  into the UI.
- The server never puts error messages, stack traces, provider URLs or
  submitted parameter values in a response. Validation errors list parameter
  names only.
- `requestId` is included only if it is an opaque token
  (`[A-Za-z0-9._:-]{1,64}`). Anything else is dropped on both sides.
- Server logs use a structured entry
  `{ event: "yield_request_failed", code, stage, requestId, errorName, errorMessage }`.
  `errorMessage` is redacted (`server/src/utils/yieldDiagnosticsLog.ts`): URL
  query strings and credentials, bearer tokens, `key=value` secrets, Stellar
  secret seeds, e-mail addresses and 32+ character opaque tokens are masked,
  and the message is truncated to 300 characters. Stack traces are not logged.

## State, balances and retries

`GET /api/yields` is read-only:

- Input is validated **before** any data source is touched, so a rejected
  request cannot trigger a refresh or a fee-history snapshot.
- A failure at any later stage writes nothing: the handler never writes the
  yield cache and never mutates source entries. Caching happens only inside
  `yieldService` during retrieval, including its existing last-good/static
  fallback, which this change does not alter.
- Building a diagnostic is pure and has no side effects.
- Retrying is therefore always safe. The client's stale-response guard
  discards an older response that resolves after a newer one, so a slow
  failure cannot overwrite fresh rates and a retry renders each row once.

No contract or balance is touched on this path.

## Compatibility

- **Additive for existing clients:** `error`, `message` and `requestId` are
  unchanged on `500`. `recoverable` and `diagnostic` are new.
- **Behaviour change:** a fee assumption parameter that is present but
  invalid (non-numeric, empty, repeated, or outside 0–10000) now returns `400`
  instead of being silently ignored. Absent parameters behave as before.
- **Bug fix:** the previous error handler wrote a second response after
  `sendError`, which threw `ERR_HTTP_HEADERS_SENT`. Failures are now answered
  exactly once.
- **Warning text:** when freshness metadata is missing, the entry's warning
  now reads "Freshness of yield data from X could not be determined." instead
  of "stale (Infinitym old)". The entry is still flagged `isStale: true`.
- `cachedFetch` results gain optional `status`, `errorBody` and `requestId`
  fields. Existing callers are unaffected.

## Adding a stage

1. Add it to `YIELD_FAILURE_STAGES`, give it a code in `YieldDiagnosticCode`,
   `YIELD_DIAGNOSTIC_CATALOG` and `CODE_BY_STAGE`.
2. Wrap the server step in `inStage("<stage>", ...)`.
3. Add a label in `YIELD_STAGE_LABELS` (`YieldDiagnosticNotice.tsx`).
4. Extend the tests in `shared/types/yieldDiagnostics.test.ts`,
   `server/src/__tests__/yieldDiagnosticsRoute.test.ts` and
   `client/src/components/dashboard/__tests__/ApyDashboard.diagnostics.test.tsx`,
   and update this document.
