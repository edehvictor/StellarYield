# Backend environment + testing guide

This guide focuses on **backend environment setup** (development, tests, production) and provides `curl` commands for exercising key API routes.

The backend validates environment at startup via `assertValidServerEnv()` (see `server/src/config/env.ts`). In development it prints warnings; in production it throws on missing required values.

---

## Minimum environment for local backend tests

GitHub Actions runs backend tests with a Postgres service and a `DATABASE_URL`. Locally, the minimum reliable setup is:

- **`DATABASE_URL`**: required for Jest tests and Prisma-backed paths.
- **`NODE_ENV`**: keep at `development` (or unset) for local work. Setting `NODE_ENV=production` intentionally turns several warnings into hard errors.

### Start a local Postgres (matches CI)

```bash
docker run --rm --name stellaryield-pg \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=stellaryield_test \
  -p 5432:5432 \
  postgres:15
```

### Install, validate, and run tests

```bash
cd server
export DATABASE_URL="postgresql://test:test@localhost:5432/stellaryield_test"

npm ci --no-audit --prefer-offline
npx prisma generate
npx prisma db push
npm test
```

---

## Development setup (local API work)

For basic local API work you can start with `server/.env.example` and only fill what you need. Commonly used values:

- **`PORT`**: defaults to `3001`
- **`STELLAR_HORIZON_URL`** / **`SOROBAN_RPC_URL`**: optional (reasonable testnet fallbacks exist)
- **`MONGODB_URI`**: optional in dev; without it, snapshot/history jobs and DB-backed routes may be unavailable
- **`RELAYER_SECRET_KEY`**: optional unless you use `/api/relayer/fee-bump` (keep sample values non-secret)

---

## Production-only requirements (examples, non-secret)

Production startup is stricter. At a minimum, expect these to be **required**:

- **`MONGODB_URI`**: persistence for DB-backed routes and jobs
- **`DATABASE_URL`**: required for Prisma-backed features and test-equivalent DB usage
- **`METRICS_TOKEN`**: required to protect `/api/metrics` (prevents unauthenticated scraping)
- **`RELAYER_SECRET_KEY`**: required if relayer endpoints are enabled/used

Example (values are placeholders; do not commit secrets):

```bash
NODE_ENV=production
PORT=3001
MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>/<db>?retryWrites=true&w=majority"
DATABASE_URL="postgresql://<user>:<password>@<host>:5432/<db>"
METRICS_TOKEN="replace-with-a-real-token"
RELAYER_SECRET_KEY="SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

### Metrics protection behavior

When `METRICS_TOKEN` is set, `/api/metrics` expects one of:

- `Authorization: Bearer <token>` or
- `x-metrics-token: <token>`

---

## Common validation errors (and fixes)

These messages come from `server/src/config/env.ts`:

- **`PORT must be a number when provided.`**
  - Fix: set `PORT=3001` (not `PORT=abc`).
- **`DATABASE_URL is not set...`**
  - Fix (tests/CI parity): set `DATABASE_URL` and ensure Postgres is reachable, then run `npx prisma generate` + `npx prisma db push`.
- **`MONGODB_URI is not set...`**
  - Fix: set `MONGODB_URI` (required in production; advisory in dev).
- **`METRICS_TOKEN is required in production to protect /api/metrics.`**
  - Fix: set a real token in production deployments and configure your metrics scraper to send it.
- **`RELAYER_SECRET_KEY must be set...`**
  - Fix: only required if you use relayer endpoints; use a real Stellar secret in secure environments (never commit).
- **`DEX_ROUTER_CONTRACT_ID and ZAP_QUOTE_SIM_SOURCE_ACCOUNT must be configured together.`**
  - Fix: set both variables (or neither). Partial configuration is rejected.

## Metrics endpoints (production protection)

In production, metrics endpoints are protected by `METRICS_TOKEN` and return **404** when unauthorized to avoid advertising the endpoint:

- JSON metrics: `GET /api/metrics`
- Prometheus scrape: `GET /metrics`

Both accept either:

- `Authorization: Bearer <token>` or
- `x-metrics-token: <token>`

For **token rotation steps** and post-rotation validation commands, see [docs/metrics-token-rotation.md](./metrics-token-rotation.md).

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

### Link a postmortem

After mitigation or resolution, create a public postmortem from
[`docs/postmortems/TEMPLATE.md`](./postmortems/TEMPLATE.md) and link the
incident record to that document from transparency views. The expected metadata
field is `postmortemUrl`; see
[`docs/incident-postmortems.md`](./incident-postmortems.md) for the full
linking flow and safety rules.

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

## 6. Server Route Ownership Map

The following table maps each route file in `server/src/routes/` to its primary endpoints, active responsibilities, related service layers, and test suites:

| Route File (in `server/src/routes/`) | Primary Responsibilities / Endpoints | Related Service Files (in `server/src/services/`) | Related Test Files (in `server/src/__tests__/`) |
| :--- | :--- | :--- | :--- |
| `activityTimeline.ts` | `GET /:walletAddress` - Build unified chronological timeline of user events (deposits, rebalances, rewards, etc.) | `accountActivityTimelineService.ts` | N/A |
| `admin.ts` | `/vaults/*` (update params/metadata, pause/resume), `/fees/config`, `/risk/parameters`, `/audit-*` (logs, stats, export, verify), `/users/*`, `/recommendations/*` (freeze, resume) - Operator commands & admin actions | `freezeService.ts`, `ipfs/vaultMetadataService`, `strategyStateTransitionAuditService.ts` | `stellarAuth.test.ts`, `vaultMetadataService.test.ts`, `vaultMetadataValidation.test.ts` |
| `alerts.ts` | `POST /`, `GET /:wallet`, `DELETE /:id` - Create, view, and delete automated user APY alert thresholds | `alertsService.ts`, `alertsPreferenceRules.ts` | `alerts.test.ts` |
| `analytics.ts` | `/attribution/*`, `/compatibility/*`, `/health/*`, `/sources/health`, `/reliability/*`, `/dashboard`, `/strategy-state-transitions/*`, `/recommendation-stability/*`, `/providers/uptime` - Yield analytics dashboard data | `portfolioAttributionService.ts`, `protocolCompatibilityService.ts`, `strategyHealthService.ts`, `yieldReliabilityService.ts`, `strategyStateTransitionAuditService.ts`, `yieldSourceRegistryService.ts`, `recommendationStabilityService.ts` | `analyticsRoutes.contract.test.ts`, `analyticsRoutes.simple.test.ts` |
| `analyticsUtils.ts` | Helper utilities (request validation, report formatting, reliability scoring) for the analytics router | `portfolioAttributionService.ts`, `yieldReliabilityService.ts` | `analyticsRoutes.simple.test.ts` |
| `auditMonitoring.ts` | `/alerts`, `/status`, `/report`, `/export`, `POST /start`, `/stop` - System-wide audit security log monitoring & integrity replays | `auditReplayService.ts` (monitored by `utils/auditMonitoring`) | `auditReplay.test.ts` |
| `contacts.ts` | `GET /`, `GET /:id`, `POST /`, `PUT /:id`, `DELETE /:id`, `/search`, `/export`, `/import` - CRUD for client-side encrypted contacts | `PrismaClient` (direct database access) | N/A |
| `correlation.ts` | `GET /:protocolA/:protocolB` - Retrieve historical correlation coefficients between two yield protocols | `correlationService.ts` | `correlationService.test.ts` |
| `deposits.ts` | `POST /route` - Multi-protocol deposit allocation routing optimizer | `depositRoutingService.ts` | `portfolio.test.ts` |
| `donations.ts` | `/` - Handles user charity protocol donation logs | `PrismaClient` (direct database access) | `donations.test.ts` |
| `export.ts` | `POST /export/preview`, `/export/download` - Tax lot data previews and CSV export file downloads | `exportService.ts` | `exportService.test.ts`, `csvExport.test.ts`, `taxLotPreview.test.ts` |
| `fees.ts` | `/` - Fetches current transactional network gas and protocol fee details | `feeOracleService.ts` | N/A |
| `fragmentation.ts` | `GET /fragmentation`, `/fragmentation/history` - Retrieve liquidity fragmentation metrics & historical TVL splits | `MockFragmentationService`, `MockHistoricalService` | `fragmentation.test.ts`, `fragmentationHistory.test.ts` |
| `governance.ts` | `/` - Governance voting shifts APY impact forecasting | `governanceForecastService.ts` | `governanceForecast.test.ts` |
| `health.ts` | `GET /` - Basic service status health and indexer synchronization check | `PrismaClient` (direct database access) | `health.test.ts` |
| `incidents.ts` | `GET /`, `GET /:id`, `POST /`, `PATCH /:id/resolve`, `GET /:id/recommendations` - Track protocol risk incidents (hack/pause) | `incidentService.ts` | `incidentService.test.ts` |
| `indexer.ts` | `/` - Block indexer sync delay monitoring | `stellarNetworkService.ts` | `indexerStatus.test.ts` |
| `leaderboard.ts` | `GET /` - Fetches top depositors by TVL with cached rankings | `PrismaClient` (direct database access) | N/A |
| `momentum.ts` | `/` - Detects yield growth velocity and asset rotational triggers | `opportunityMomentumEngine.ts` | `momentumRoutes.test.ts`, `opportunityMomentumEngine.test.ts` |
| `notifications.ts` | `/` - Fetches list of in-app/email alerts | `emailService.ts` | N/A |
| `onramp.ts` | `/` - Aggregates third-party fiat-to-crypto on-ramp quotes | `PrismaClient` (direct database access) | N/A |
| `openapi.ts` | `/` - Serves standard Swagger OpenAPI spec files | Direct spec schema config | N/A |
| `pnl.ts` | `GET /pnl` - realized and unrealized yield PnL metric calculator | `pnl_engine` | `pnlCalculator.test.ts` |
| `presets.ts` | `/` - strategy allocation template presets | `allocationPresetsService.ts` | `allocationPresets.test.ts`, `treasuryPresets.test.ts` |
| `prometheusMetrics.ts` | `/metrics` - Serves live telemetry performance indicators to Prometheus scraping agent | `monitoring` telemetry utils | `prometheus.test.ts`, `metrics.test.ts` |
| `referrals.ts` | `/` - Handles user referral signup and dynamic payout distributions | `PrismaClient` (direct database access) | `server/src/routes/referrals.test.ts` (inline route test) |
| `rewards.ts` | `/` - Accumulated token rewards tracking and normalization | `rewardScheduleRegistry.ts`, `rewardScheduleHealth.ts` | `rewardNormalization.test.ts` |
| `simulator.ts` | `/` - Simulates strategy rotations or re-allocation dry runs | `simulationService.ts` | `simulationService.test.ts` |
| `strategies.ts` | `/` - Manage multi-protocol strategies, regime shifts, and manual/auto rebalancing | `strategyRotationService.ts`, `strategyRotationDryRun.ts`, `strategySnapshotVersioningService.ts` | `strategyRotationService.test.ts`, `strategyRotationDryRun.test.ts`, `strategySnapshotVersioning.test.ts` |
| `transparency.ts` | `/` - cryptographic yield attribution verification | `provenance.service.ts` | `transparency.test.ts`, `services/provenance.test.ts` |
| `treasury.ts` | `/` - DAO Treasury allocation backtesting and simulation | `treasurySimulationService.ts` | `treasurySimulation.test.ts` |
| `weeklyReports.ts` | `/` - Consolidates weekly yields reports | `weeklyYieldReportService.ts` | `weeklyYieldReport.test.ts` |
| `yields.ts` | `GET /` - Fetches baseline protocol APYs with custom fee drag calculators | `yieldService.ts`, `netYieldEngine.ts` | `netYieldEngine.test.ts`, `yieldNormalization.test.ts`, `yieldRegime.test.ts` |
| `zap.ts` | `GET /supported-assets`, `POST /quote` - Generates single-transaction multi-asset swap & vault entry routes | `zapQuote.ts`, `slippageRegistry.ts` | `zapQuote.test.ts`, `zapRoute.test.ts`, `zapSupportedAssetsRoute.test.ts`, `slippageRegistry.test.ts` |
