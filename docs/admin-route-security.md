# Administrative Route Security & Inventory

This document details the administrative access controls, route list, and authentication mechanisms in the StellarYield platform.

## Authentication & Authorization Architecture

All administrative endpoints are protected by the local `requireAdmin` middleware. The middleware validates the caller's role by checking the `role` property of the `req.user` object:

```typescript
function requireAdmin(req: Request, res: Response, next: () => void): void {
  const user = (req as any).user;
  if (!user || user.role !== "ADMIN") {
    res.status(403).json({ error: "Unauthorized: Admin access required" });
    return;
  }
  next();
}
```

### Token Processing Middleware

The `authMiddleware` located in `server/src/middleware/auth.ts` parses the incoming request's `Authorization: Bearer <token>` header:

1. **Production/JWT**: Decodes standard JSON Web Tokens (JWT) payload structures to read base64 claims (e.g. `role`, `email`, `sub`).
2. **Testing/Development**: Supports `mock-admin-token` (grants `role: "ADMIN"`) and `mock-user-token` (grants `role: "USER"`).

## Administrative Endpoint Inventory

The following endpoints are restricted to callers with the `"ADMIN"` role:

| Endpoint | Method | Purpose | Implementation Status |
|---|---|---|---|
| `/api/admin/vaults/:vaultId/parameters` | `POST` | Update parameters (e.g. limits, capacities) | Placeholder |
| `/api/admin/vaults/:vaultId/metadata` | `POST` | Upload vault configuration/icons to IPFS | Implemented |
| `/api/admin/vaults/:vaultId/pause` | `POST` | Pause strategy deposit routing | Placeholder |
| `/api/admin/vaults/:vaultId/resume` | `POST` | Resume strategy deposit routing | Placeholder |
| `/api/admin/fees/config` | `POST` | Update global fee allocations | Placeholder |
| `/api/admin/risk/parameters` | `POST` | Update risk tolerances | Placeholder |
| `/api/admin/audit-logs` | `GET` | Retrieve signed action logs | Implemented |
| `/api/admin/audit-stats` | `GET` | Retrieve log count stats | Implemented |
| `/api/admin/audit-logs/export` | `GET` | Export audit log CSV file | Implemented |
| `/api/admin/audit-verify` | `GET` | Verify hash chain integrity | Implemented |
| `/api/admin/users/:userId/revoke-access` | `POST` | Terminate user session access | Placeholder |
| `/api/admin/users/:userId/grant-access` | `POST` | Assign roles/permissions | Placeholder |
| `/api/admin/recommendations/freeze` | `POST` | Lock strategy recommendations | Implemented |
| `/api/admin/recommendations/resume` | `POST` | Unlock strategy recommendations | Implemented |

## Audit Logging

Every successful request to an administrative endpoint is audited and cryptographically hashed in sequence (integrity verification chain), persisted, and signable by the `auditMiddleware`.

### Filtering the audit log

`GET /api/admin/audit-logs` and `GET /api/admin/audit-logs/export` accept the same optional filters, combined with AND. Blank values are ignored.

| Parameter | Meaning |
|---|---|
| `wallet` | A Stellar public key (`G…`, 56 characters; matched case-insensitively). Matches entries where the wallet is the acting identity (`userId`), the target (`resourceId`), or a wallet recorded under a wallet-like key of `changes` (`wallet`, `walletAddress`, `address`, `userAddress`, `owner`, `recipient`, `account`, `actorAddress`, `targetWallet`; up to three levels deep). |
| `action` | One action, a comma-separated list (`A,B`), or a repeated parameter (`action=A&action=B`). Matched case-insensitively; at most 20 actions. |
| `startDate`, `endDate` | A calendar date (`2025-03-31`) or an ISO 8601 date-time **with a zone** (`2025-03-31T10:00:00Z`, `…+02:00`). A date-only `startDate` is the start of that UTC day and a date-only `endDate` is the end of that UTC day, so `startDate=endDate=2025-03-31` selects the whole day. |
| `userId`, `resource` | Exact match, as before. |

Invalid filters answer `400` with a stable code instead of returning an empty page:

```json
{
  "error": "INVALID_DATE",
  "message": "endDate must be a calendar date (YYYY-MM-DD) or an ISO 8601 date-time with a time zone.",
  "details": { "field": "endDate" }
}
```

The codes are `INVALID_WALLET`, `INVALID_ACTION`, `INVALID_DATE`, `INVALID_DATE_RANGE` (start after end) and `INVALID_FILTER` (a single-valued filter sent more than once).

The list response echoes the normalised filters under `filters` (for example the upper-cased `wallet` and the resolved UTC instants), next to the usual `data` and `pagination`. Cursors keep working with filters: send the same filters with each page.

The CSV export returns every matching entry up to 10,000 rows. When more match, the response carries the header `X-Audit-Export-Truncated: true`; narrow the filters to export the rest. (Previously an export silently held only the first 100 entries.)

The admin UI at `/admin/audit-logs` exposes these filters, with client-side validation that mirrors the rules above.
