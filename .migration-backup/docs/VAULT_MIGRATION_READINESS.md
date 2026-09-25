# Vault Migration Readiness Checklist (#1293)

A deterministic, read-only readiness checklist that evaluates whether a vault is
safe to migrate. It never executes a migration — it surfaces the evidence
operators need to decide, with typed statuses that are reproducible across runs.

## Checklist source of truth

The gate template lives at `contracts/scripts/migration-readiness-gates.json`.
It defines the machine-readable gates (question, affected target area, evidence
type, reference, and remediation guidance). The server evaluates every gate
against deterministic evidence; the client renders the result.

| Gate | Evidence type | Pass means |
|---|---|---|
| Vault contract registered | `CONTRACT_ADDRESS` | `contracts/registry.json` has a vault address for the active network |
| Yield feed live | `YIELD_STATS` | `/api/yields` has a non-stale entry for the vault protocol/asset |
| Share price history available | `SHARE_PRICE_HISTORY` | the indexer has at least one share-price snapshot |
| Backend healthy | `BACKEND_HEALTH` | the yields feed responds |
| Deposits available | `DEPOSIT_AVAILABLE` | contract + stats are present, so deposits are not blocked |
| Withdrawals priced and available | `WITHDRAW_AVAILABLE` | share pricing basis is available |

## API

```
GET /api/vaults/migration-readiness/:slug
```

Response envelope (deterministic `data`, no wall-clock fields inside the payload):

```json
{
  "ok": true,
  "data": {
    "vaultSlug": "usdc",
    "vaultName": "USDC Yield Vault",
    "network": "testnet",
    "overallStatus": "not_ready",
    "statusCounts": { "pass": 3, "warn": 0, "fail": 1, "unknown": 0 },
    "gates": [
      {
        "id": "registry-entry",
        "title": "Vault contract registered",
        "status": "pass",
        "evidence": ["Registry address present for network \"testnet\""]
      }
    ]
  }
}
```

Errors are typed and do not rely on parsing provider messages:

- `UNKNOWN_VAULT` (400) — the slug is not in `VAULT_REGISTRY`.
- `GATES_TEMPLATE_UNAVAILABLE` (500) — the gates template cannot be read or is malformed.
- `INTERNAL_ERROR` (500) — unexpected failure while gathering evidence.

## Overall status policy

- Any gate `fail` → `not_ready`.
- No fails but any `unknown` → `unknown`.
- Otherwise (`pass`/`warn`) → `ready`.

Warnings (`warn`) do not block readiness but are surfaced as caveats, e.g. "share
price database unavailable — deterministic fixture in use".

## Running the checks

- The gates template integrity is covered by `contracts/__tests__/migrationReadinessGates.test.ts`.
- Server policy is covered by `server/.../vaultMigrationReadinessService.test.ts`.
- The client panel (`client/src/components/VaultMigrationReadinessPanel.tsx`)
  handles loading, failure, empty, and success states and is mounted on the
  vault page (`/vault/:slug`).