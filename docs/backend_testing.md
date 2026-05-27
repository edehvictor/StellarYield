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

_Note: These commands require the admin role. If the `requireAdmin` middleware is active, you may need an auth token._

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

## 5. Rate Limiting

The StellarYield backend implements rate limiting on several endpoints to prevent abuse and ensure fair resource allocation. This section documents the rate-limited endpoints and how to handle rate limit responses.

### Rate-Limited Endpoints

| Endpoint               | Method | Limit       | Window     | Purpose                         |
| ---------------------- | ------ | ----------- | ---------- | ------------------------------- |
| `/api/docs`            | GET    | 60 requests | 15 minutes | OpenAPI documentation access    |
| `/api/openapi.yaml`    | GET    | 60 requests | 15 minutes | OpenAPI specification retrieval |
| `/metrics`             | GET    | 10 requests | 1 minute   | Prometheus metrics scrape       |
| `/api/export/preview`  | POST   | 5 requests  | 15 minutes | Tax export preview generation   |
| `/api/export/download` | POST   | 5 requests  | 15 minutes | Tax export file download        |

### Rate Limit Response Headers

When a request is rate-limited, the server responds with HTTP 429 (Too Many Requests) and includes the following headers:

```
RateLimit-Limit: <max-requests>
RateLimit-Remaining: <remaining-requests>
RateLimit-Reset: <unix-timestamp>
```

Example response:

```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 60
RateLimit-Remaining: 0
RateLimit-Reset: 1234567890
Content-Type: application/json

{
  "error": "Too many requests",
  "message": "Too many API documentation requests. Please try again later."
}
```

### Testing Rate Limits

#### Test OpenAPI Documentation Rate Limit

```bash
# Make 61 requests to trigger the rate limit (limit is 60 per 15 minutes)
for i in {1..61}; do
  curl -X GET http://localhost:3001/api/docs
  echo "Request $i"
done

# The 61st request should return 429
```

#### Test Metrics Endpoint Rate Limit

```bash
# Make 11 requests to trigger the rate limit (limit is 10 per 1 minute)
for i in {1..11}; do
  curl -X GET http://localhost:3001/metrics \
    -H "x-metrics-token: your-token"
  echo "Request $i"
done

# The 11th request should return 429
```

#### Test Export Rate Limit

```bash
# Make 6 requests to trigger the rate limit (limit is 5 per 15 minutes)
for i in {1..6}; do
  curl -X POST http://localhost:3001/api/export/preview \
    -H "Content-Type: application/json" \
    -d '{"address": "GXXXXX..."}'
  echo "Request $i"
done

# The 6th request should return 429
```

### Frontend Retry and Backoff Strategy

When receiving a 429 response, clients should implement exponential backoff:

```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (response.status === 429) {
      const resetTime = response.headers.get("RateLimit-Reset");
      const retryAfter = resetTime
        ? new Date(parseInt(resetTime) * 1000).getTime() - Date.now()
        : Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s

      if (attempt < maxRetries - 1) {
        console.warn(`Rate limited. Retrying after ${retryAfter}ms`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter));
        continue;
      }
    }

    return response;
  }

  throw new Error("Max retries exceeded");
}
```

### Production Considerations

- Rate limits are enforced per IP address by default
- In production, consider using a reverse proxy (nginx, CloudFlare) for additional rate limiting
- Monitor rate limit violations in logs to detect potential abuse
- Adjust limits based on observed traffic patterns and resource constraints
- Use the `RateLimit-Reset` header to inform users when they can retry

### Disabling Rate Limits (Development Only)

To disable rate limiting during development, set the `DISABLE_RATE_LIMITS` environment variable:

```bash
DISABLE_RATE_LIMITS=true npm run dev
```

Note: This should never be used in production.
