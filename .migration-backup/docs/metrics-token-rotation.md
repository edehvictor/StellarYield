# Metrics token rotation (production)

In production, StellarYield protects metrics endpoints with `METRICS_TOKEN`:

- JSON metrics: `GET /api/metrics`
- Prometheus scrape: `GET /metrics`

Both endpoints accept either:

- `Authorization: Bearer <token>` or
- `x-metrics-token: <token>`

This guide explains how to rotate the token without downtime and without leaking secrets in logs or PRs.

---

## Goals and constraints

- **Do not log tokens** in CI, terminals, dashboards, or support requests.
- **No downtime**: allow the new token to be verified before deprecating the old one.
- **Least privilege**: store the token only in your secrets manager / deployment platform.

---

## Recommended rotation approach (two-token window)

The backend currently supports a single `METRICS_TOKEN` value. To rotate safely, you need a short window where both tokens work. There are two operational ways to do this:

### Option A: rotate via proxy (recommended)

1. Keep the backend configured with the **old** token.
2. Update your scraper/proxy to send the **new** token upstream while translating to the old token at the backend boundary.
3. Deploy backend with the **new** `METRICS_TOKEN`.
4. Remove translation once the backend is fully on the new token.

This avoids a period where scrapes fail, and avoids needing the backend to accept two tokens.

### Option B: coordinated cutover (simple, small risk)

If you can tolerate a short scrape gap:

1. Update the backend deployment secret `METRICS_TOKEN` to the **new** value.
2. Deploy.
3. Update the metrics scraper configuration to use the **new** value.

---

## Step-by-step: coordinated cutover (Option B)

### 1) Prepare a new token

Generate a long random token (store it only in your secret manager). Example commands:

```bash
# macOS / Linux (prints the token ONCE; do not paste into logs)
openssl rand -base64 48
```

Do **not** commit the token anywhere. Do **not** paste it into GitHub issues or PRs.

### 2) Update the production secret

Update `METRICS_TOKEN` in your production environment (Vercel, container runtime, systemd unit, Kubernetes secret, etc.).

### 3) Deploy backend

Redeploy the backend so `process.env.METRICS_TOKEN` updates.

### 4) Validate access after rotation

Validate both endpoints using header-based auth (do not put tokens in URLs).

```bash
export BACKEND_URL="https://your-backend.example.com"
export METRICS_TOKEN="REDACTED"  # shell history risk: consider typing directly instead of export

# JSON metrics
curl -fsS "$BACKEND_URL/api/metrics" -H "x-metrics-token: $METRICS_TOKEN" | jq .

# Prometheus scrape (plain text)
curl -fsS "$BACKEND_URL/metrics" -H "Authorization: Bearer $METRICS_TOKEN" | head
```

Expected outcomes:

- With the correct token: **200**
- With a missing/incorrect token in production: **404** (intentional)

### 5) Update your scraper

Update Prometheus / Grafana Agent / whatever scrapes the endpoint to send the new header:

- `Authorization: Bearer <token>` or `x-metrics-token: <token>`

Then confirm scrapes are succeeding again and dashboards show fresh timestamps.

---

## Validating production configuration (optional check)

Before deploying, you can run the optional check script:

```bash
cd server
NODE_ENV=production METRICS_TOKEN="REDACTED" node scripts/check-metrics-token.js
```

This script **never prints the token**, it only validates presence when `NODE_ENV=production`.

---

## Troubleshooting

- **Metrics endpoint returns 404 in production**
  - Wrong or missing header, or the backend is running without `METRICS_TOKEN`.
  - Confirm `METRICS_TOKEN` is set in the runtime environment and the scraper is sending the correct header.
- **Metrics scrape is rate-limited (429)**
  - `/metrics` is rate-limited to reduce brute-force attempts. Adjust scrape intervals or spread scrapes across time.

---

## Recovery steps

Use this section when a rotation goes wrong or the backend fails startup validation due to missing or placeholder secrets.

### Symptom: server fails to start in production (`METRICS_TOKEN` error)

The startup validator (`assertValidServerEnv`) will throw if `METRICS_TOKEN` is missing or is a known placeholder value like `replace-with-a-real-token` or `change-this`.

**Recovery:**

1. Generate a new token (see step 1 of the rotation guide above).
2. Set `METRICS_TOKEN` in your production secrets manager / deployment platform to the new value.
3. Redeploy the backend.
4. Verify startup succeeds and `/api/metrics` returns 200 with the correct header.

### Symptom: server fails to start in production (`AUDIT_SIGNING_KEY` error)

The startup validator will also reject a missing or placeholder `AUDIT_SIGNING_KEY` (e.g. `your-secure-signing-key-change-this-in-production`).

**Recovery:**

1. Generate a strong random key:
   ```bash
   openssl rand -base64 48
   ```
2. Set `AUDIT_SIGNING_KEY` in your production secrets manager to the new value. Do not commit it.
3. Redeploy the backend.

> **Note:** Changing `AUDIT_SIGNING_KEY` invalidates existing HMAC signatures on stored audit entries. If your audit replay/verification pipeline checks historical signatures, re-sign affected entries or note the rotation timestamp as a boundary in your audit log policy.

### Symptom: startup error after rotation — old placeholder still in env

If the deployment platform cached a previous env snapshot with a placeholder value:

1. Force-update the secret in the platform (some platforms require explicit re-save even if the value appears set).
2. Trigger a fresh deployment (do not reuse the cached image).
3. Confirm the new value is active by checking that the backend starts without validation errors.

### Checking validation locally before deploying

Run the preflight check script against your staging config without deploying:

```bash
cd server
NODE_ENV=production \
  METRICS_TOKEN="your-real-token" \
  AUDIT_SIGNING_KEY="your-real-key" \
  node scripts/check-metrics-token.js
```

For a full env validation check, set all required production variables and run the backend briefly in dry-run mode, or write a small script that calls `validateServerEnv` directly from `server/src/config/env.ts`.

