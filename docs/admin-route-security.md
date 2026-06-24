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
