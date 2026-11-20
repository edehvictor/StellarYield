# Alert preferences: concurrent updates

Alert preferences are stored per wallet + vault. Two tabs, two devices, or a
revert racing an edit could previously overwrite each other silently (last
write wins). Since #1903 every preference record carries a **version** and
writes can be made conditional on it (optimistic concurrency).

## Versions

- A wallet + vault with no preferences is at version `0`.
- Every committed write (`PUT /api/alerts/preferences`,
  `PUT /api/alerts/:wallet/preferences/:vaultId`, the revert route, and the
  initial preferences set by `POST /api/alerts`) increments the version by one.
- Reads return it as `ETag: "<version>"` and `X-Preferences-Version`;
  `GET /api/alerts/:wallet/preferences/:vaultId` also returns `version` in the body.

## Conditional writes

Send the version you read as `If-Match: "<version>"` (`W/"<version>"` and a
bare number are also accepted), or as `expectedVersion` in the JSON body.
`"0"` means "create only".

| Situation | Response | State |
| --- | --- | --- |
| Version matches | `200`, new version in `ETag` | written, audited |
| Another write committed first | `409 PREFERENCE_VERSION_CONFLICT` with `expectedVersion`, `currentVersion`, `preferences` | unchanged |
| Malformed version | `400 INVALID_EXPECTED_VERSION` | unchanged |
| No version sent | `200` (unconditional, as before) | written |

The version check, the write, the version bump and the audit record run as one
synchronous step in the service, so no other request can interleave between
the check and the write. If recording the audit entry fails, the previous
preferences and version are restored before the error is returned.

## Retries

- A retry with the same `X-Operation-Identity` / `Idempotency-Key` returns the
  original result and version (`X-Idempotent-Replayed: true`) even if the
  record moved on since; it writes nothing.
- A write rejected with `409 PREFERENCE_VERSION_CONFLICT` does **not** consume
  its operation identity, so it can be retried with the reloaded version.

## Client

`client/src/features/alerts/alertsApi.ts`:

- `fetchAlertPreferencesVersioned` → `{ preferences, version }`.
- `saveAlertPreferencesVersioned(wallet, vault, prefs, { expectedVersion, operationIdentity })`
  throws `AlertPreferencesConflictError` (with `currentVersion` and
  `currentPreferences`) on a version conflict.
- `updateAlertPreferencesSafely(wallet, vault, change, maxAttempts = 3)` reads,
  applies `change`, saves against that version, and on a conflict re-applies
  `change` to the server's newer record. Other errors are not retried.
- `fetchAlertPreferences` / `saveAlertPreferences` keep their signatures;
  `saveAlertPreferences` takes an optional fifth `expectedVersion`.

## Tests

- `server/src/__tests__/alertPreferencesConcurrency.test.ts`
- `client/src/features/alerts/__tests__/alertsApi.concurrency.test.ts`
