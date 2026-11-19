# Frontend Deployment Configuration

This document describes the required and recommended public API settings for deploying the StellarYield client to production or preview environments.

## Required Settings

All of the following environment variables **must** be configured before building the client. The build will fail with a clear error message if any are missing or invalid.

### `VITE_SOROBAN_RPC_URL`

**Required:** Yes  
**Type:** URL  
**Format:** Must start with `http://` or `https://`

The Soroban RPC endpoint used for querying contract state and submitting transactions.

**Examples:**
- Production: `https://soroban-mainnet.stellar.org`
- Testnet: `https://soroban-testnet.stellar.org`
- Local: `http://localhost:8000`

**Default:** None (build fails if not set)

---

### `VITE_NETWORK_PASSPHRASE`

**Required:** Yes  
**Type:** String  
**Format:** Non-empty string identifying the Stellar network

The network passphrase used to sign transactions. Must match the network where your contracts are deployed.

**Examples:**
- Production (Mainnet): `Public Global Stellar Network ; September 2015`
- Testnet: `Test SDF Network ; September 2015`
- Local/Standalone: `Standalone Network ; February 2021`

**Default:** None (build fails if not set)

---

### `VITE_CONTRACT_ID`

**Required:** Yes  
**Type:** String (Soroban Contract Address)  
**Format:** Non-empty valid contract ID

The contract ID (address) of the main Vault contract deployed to the target network.

**Examples:**
- `CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA`
- `CB7D4CK7PD5VVEJSWMJYAPGKWHH7ZQPTF6PQTMWMYAPGKWHH7ZQPT`

**Default:** None (build fails if not set)

---

## Recommended Settings

The following settings are optional but recommended for production deployments. The build will succeed without them, but a warning will be displayed.

### `VITE_API_BASE_URL`

**Required:** No (but recommended for production)  
**Type:** URL  
**Format:** Must start with `http://` or `https://`

The backend API base URL. If not configured, the client defaults to the same origin (relative requests).

**Examples:**
- Production: `https://api.stellaryield.com`
- Preview: `https://api-preview.stellaryield.com`
- Local: `http://localhost:3001`

**Default:** Same origin (relative requests to `/api/*`)

---

### `VITE_ZAP_CONTRACT_ID`

**Required:** No  
**Type:** String (Soroban Contract Address)

Contract ID for the Zap contract (swap aggregation). Enable swap functionality.

**Default:** Not set (swap features disabled)

---

### `VITE_VESTING_CONTRACT_ID`

**Required:** No  
**Type:** String (Soroban Contract Address)

Contract ID for the Vesting contract. Enables vesting/lockup features.

**Default:** Not set (vesting features disabled)

---

## Other Configuration

The `.env.example` file includes additional optional settings:

- `VITE_VESTING_CONTRACT_ID` – Vesting contract
- `VITE_TOKEN_CONTRACT_ID` – Token contract
- `VITE_ZAP_ASSETS_JSON` – Asset metadata
- `VITE_APP_URL` – Public app URL (for metadata)
- `VITE_OFFRAMP_BASE_URL` – Off-ramp integration URL
- `VITE_GOOGLE_CLIENT_ID` – Optional Google integration

These do not block deployment if missing.

---

## Setting Environment Variables

### Local Development

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp client/.env.example client/.env.local
   ```

2. Edit `client/.env.local` with your local values:
   ```env
   VITE_SOROBAN_RPC_URL=http://localhost:8000
   VITE_NETWORK_PASSPHRASE=Standalone Network ; February 2021
   VITE_CONTRACT_ID=CAAA7HSEA7GTXNMDJVVHGKZGP7T2Z3XDVVQQKZQVVGKZGP7T2Z3XDVVPNA
   VITE_API_BASE_URL=http://localhost:3001
   ```

3. Run `npm run dev` to start the dev server.

### Vercel Deployment

1. Go to **Settings → Environment Variables**
2. Add each required variable:
   - `VITE_SOROBAN_RPC_URL`
   - `VITE_NETWORK_PASSPHRASE`
   - `VITE_CONTRACT_ID`
3. Recommended: Also set `VITE_API_BASE_URL` for preview deployments

Vercel automatically injects these during the build. The validation script will run and fail the build if required settings are missing.

### Other CI/CD Platforms

Set the environment variables in your CI/CD platform's environment configuration:

- **GitHub Actions:** Use secrets or environment variables in workflow
- **GitLab CI:** Set in project variables
- **AWS Amplify:** Use build environment variables
- **Firebase Hosting:** Set in deployment configuration

The validation script automatically picks up variables from the environment during the `npm run build` step.

---

## Build Validation

The build process automatically validates configuration before finalizing the output:

```bash
npm run build
```

This runs (in order):

1. **Prebuild:** SDK compilation + **deployment config validation**
2. **Build:** TypeScript compilation + Vite bundling

### Validation Output

**Success:**
```
🔍 Deployment Configuration Validation

✅ All required public API settings are configured.
```

**Missing Required Setting:**
```
🔍 Deployment Configuration Validation

❌ FATAL: Missing required environment settings:

   • VITE_CONTRACT_ID
     Main Vault contract ID (Soroban contract address)

Build cannot proceed. Set the missing environment variables and try again.
For guidance, see: docs/frontend-deployment-config.md
```

**Warnings (build proceeds):**
```
🔍 Deployment Configuration Validation

⚠️  Recommended public API settings not configured:

   • VITE_API_BASE_URL: Backend API base URL (e.g., https://api.stellaryield.com)
   • VITE_ZAP_CONTRACT_ID: ZAP contract ID (for swap functionality)

Note: Build will proceed, but some features may not work as expected.
```

---

## Troubleshooting

### "VITE_CONTRACT_ID is required but missing"

**Solution:**
1. Check that `VITE_CONTRACT_ID` is set in your environment: `echo $VITE_CONTRACT_ID`
2. For local development, copy `.env.example` to `.env.local` and set the value
3. For CI/CD, verify the environment variable is configured in your platform

### "Invalid API URL configuration"

**Problem:** `VITE_API_BASE_URL` or `VITE_SOROBAN_RPC_URL` doesn't start with `http://` or `https://`

**Solution:** Update the variable to include the protocol:
```env
# ✗ Wrong
VITE_API_BASE_URL=api.stellaryield.com

# ✓ Correct
VITE_API_BASE_URL=https://api.stellaryield.com
```

### Build succeeds but API calls fail

**Possible causes:**
- `VITE_API_BASE_URL` is not configured for non-local deployments
- The backend API is not reachable from the deployment environment
- CORS is not properly configured on the backend

**Solution:**
1. Check that `VITE_API_BASE_URL` is set (run validation: `npm run build` without actually deploying)
2. Verify backend CORS allows requests from your deployment domain
3. Check network tab in browser DevTools to see actual request URLs

---

## Summary Table

| Setting | Required | Type | Default |
|---------|----------|------|---------|
| `VITE_SOROBAN_RPC_URL` | ✅ Yes | URL | None – build fails |
| `VITE_NETWORK_PASSPHRASE` | ✅ Yes | String | None – build fails |
| `VITE_CONTRACT_ID` | ✅ Yes | Contract ID | None – build fails |
| `VITE_API_BASE_URL` | ❌ No | URL | Same origin (relative) |
| `VITE_ZAP_CONTRACT_ID` | ❌ No | Contract ID | Not set |
| `VITE_VESTING_CONTRACT_ID` | ❌ No | Contract ID | Not set |

---

## References

- [Vite Environment Variables](https://vitejs.dev/guide/env-and-mode.html)
- [Stellar Soroban Documentation](https://developers.stellar.org/learn/building-with-stellar/soroban)
- [Contract Registry](../contracts/registry.json)
