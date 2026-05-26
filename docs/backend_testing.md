# Backend Testing Guide via CLI

This guide provides `curl` commands to test the new features implemented in the StellarYield backend.

## 1. APY Attribution Breakdown (#287)
Fetch the yield data to see the new `attribution` object for each protocol.

```bash
curl -X GET http://localhost:3001/api/yields | jq
```

## 2. Risk Incident Chronicle (#286)

### Fetch all incidents
```bash
curl -X GET http://localhost:3001/api/incidents | jq
```

### Create a new incident
```bash
curl -X POST http://localhost:3001/api/incidents \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "Blend",
    "severity": "HIGH",
    "type": "PAUSE",
    "title": "Protocol Upgrade Delay",
    "description": "Blend protocol is undergoing maintenance and deposits are temporarily paused.",
    "affectedVaults": ["USDC-Yield-1"],
    "startedAt": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'"
  }' | jq
```

### Resolve an incident
Replace `ID` with the actual incident ID from the previous command.
```bash
curl -X PATCH http://localhost:3001/api/incidents/ID/resolve | jq
```

## 3. Emergency Freeze Control (#288)
*Note: These commands require the admin role. If the `requireAdmin` middleware is active, you may need an auth token.*

### Freeze a specific protocol (e.g., Soroswap)
```bash
curl -X POST http://localhost:3001/api/admin/recommendations/freeze \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "Soroswap",
    "reason": "Observed abnormal price volatility"
  }' | jq
```

### Freeze all recommendations globally
```bash
curl -X POST http://localhost:3001/api/admin/recommendations/freeze \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Global network maintenance"
  }' | jq
```

### Resume recommendations
```bash
curl -X POST http://localhost:3001/api/admin/recommendations/resume \
  -H "Content-Type: application/json" \
  -d '{
    "protocol": "Soroswap"
  }' | jq
```

## 4. Slippage Model Registry (#278)
Test a zap quote to see the `slippageApplied` and `amountOutAfterSlippage` fields.

```bash
curl -X POST http://localhost:3001/api/zap/quote \
  -H "Content-Type: application/json" \
  -d '{
    "inputTokenContract": "CBG64B62J46NIF6S4C5E",
    "outputTokenContract": "CC64B62J46NIF6S4C5E",
    "amountInStroops": "10000000",
    "protocol": "Blend"
  }' | jq
```

## Rate-limited endpoints

Several backend endpoints use `express-rate-limit` to protect expensive or sensitive operations. Clients should treat HTTP `429` responses as retryable only after waiting for the limiter window to reset.

| Endpoint | Limit | Source |
| --- | --- | --- |
| `POST /api/relayer/fee-bump` | 3 requests per 15 minutes per IP | `server/src/app.ts` |
| `GET /api/users/:address/export` | 5 requests per 15 minutes per IP | `server/src/routes/export.ts` |
| `GET /api/openapi` | 60 requests per 15 minutes per IP | `server/src/routes/openapi.ts` |
| `GET /api/openapi/docs` | 60 requests per 15 minutes per IP | `server/src/routes/openapi.ts` |
| `GET /metrics` | 10 requests per minute per IP | `server/src/routes/prometheusMetrics.ts` |

### Expected 429 behavior

When a limiter is exceeded, the API returns HTTP `429` with a short plain-text message such as:

```text
Too many requests, please try again later.
```

The `/metrics` endpoint enables standard rate-limit headers and disables legacy headers, so Prometheus or other scrape clients can distinguish rate limiting from missing authorization. Other limited endpoints rely on the default `express-rate-limit` response behavior.

### Frontend retry guidance

- Do not retry immediately after a `429`.
- Show a user-facing message that the operation is temporarily rate limited.
- Use exponential backoff for background retries, and stop retrying once the user cancels or navigates away.
- For export downloads, keep the existing request available to the user instead of starting repeated export attempts.
- For relayer fee-bump requests, ask the user to wait before submitting another transaction request.
