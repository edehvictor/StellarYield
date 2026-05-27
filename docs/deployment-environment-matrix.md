# Deployment Environment Matrix

This document describes how the three StellarYield environments differ — local development, Vercel Preview, and Vercel Production — so contributors know exactly which variables to set and what to expect in each context.

For the full list of every `VITE_` variable the frontend reads, see [docs/frontend-env-reference.md](./frontend-env-reference.md).

---

## Environment Overview

| | Local | Vercel Preview | Vercel Production |
|---|---|---|---|
| Triggered by | `npm run dev` | PR branch push | Merge to default branch |
| Frontend URL | `http://localhost:5173` | Auto-generated Vercel URL | `https://stellaryield.vercel.app` |
| Backend URL | `http://localhost:3001` | Shared staging backend (manual) | Production backend service |
| Stellar network | Testnet | Testnet (recommended) | Mainnet |
| Contract IDs | Testnet contracts | Testnet contracts | Mainnet contracts |
| Backend deploy | Manual (`npm run dev`) | Not auto-deployed by Vercel | Not auto-deployed by Vercel |

---

## Local Development

### Requirements

- Node.js 20+ and npm 10+
- Rust stable toolchain (for contract work)
- Soroban CLI (for contract deployment and testing)

### Frontend Setup

```bash
cd client
npm ci
cp .env.example .env.local
# Edit .env.local with your testnet values
npm run dev
```

Frontend runs at `http://localhost:5173`.

### Required `.env.local` Values

```dotenv
VITE_API_BASE_URL=http://localhost:3001
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_CONTRACT_ID=<your testnet contract ID>
```

All other `VITE_` variables are optional for local development. Features that depend on them will show a "not configured" state rather than crashing.

### Backend Setup

```bash
cd server
npm ci
cp .env.example .env
npm run dev
```

Backend runs at `http://localhost:3001`. The frontend's `VITE_API_BASE_URL` must point here.

### No External Services Required

Local development does not require a live Vercel project, external OAuth credentials, or an off-ramp API key. All optional integrations (Google Sheets export, MoonPay) gracefully disable themselves when their variables are absent.

---

## Vercel Preview

### When It Runs

A Preview deployment is created automatically on every pull request branch push. Each Preview deployment gets its own unique URL (e.g. `stellaryield-pr-42-abc123.vercel.app`).

### Environment Variable Scope

Vercel scopes environment variables per environment (Production, Preview, Development). Variables set under **Preview** are not inherited by Production. You must set each variable explicitly in the correct scope.

Required variables for Preview deployments:

| Variable | Recommended value |
|---|---|
| `VITE_API_BASE_URL` | URL of a shared staging backend or a local tunnel |
| `VITE_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `VITE_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` |
| `VITE_CONTRACT_ID` | Testnet contract ID |

### Backend

The `server/` backend is **not** deployed automatically by Vercel. Preview frontends typically point to a manually deployed staging instance of the backend. If no staging backend is available, set `VITE_API_BASE_URL` to a local development tunnel (e.g. ngrok).

### Common Preview Failure

If a Preview build succeeds but the app shows no data, check that `VITE_API_BASE_URL` under the Preview scope points to a reachable backend. The build will succeed even if the backend is unreachable — it is a runtime dependency, not a build-time one.

---

## Vercel Production

### When It Runs

A Production deployment is triggered when a commit is merged into the default branch. The live site at `https://stellaryield.vercel.app` is updated.

### Environment Variable Scope

All required variables must be set under the **Production** scope in the Vercel dashboard. Do not rely on Preview values carrying over — Vercel scopes are independent.

Required variables for Production:

| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | URL of the production backend service |
| `VITE_SOROBAN_RPC_URL` | Mainnet Soroban RPC endpoint |
| `VITE_NETWORK_PASSPHRASE` | `Public Global Stellar Network ; September 2015` |
| `VITE_CONTRACT_ID` | Mainnet vault contract ID |
| `VITE_VAULT_TOKEN_SYMBOL` | `USDC` (or the correct production token symbol) |

Contract IDs and `VITE_NETWORK_PASSPHRASE` must be consistent. Mixing testnet contract IDs with the mainnet passphrase (or vice versa) is the most common production bug.

### Vercel Project Settings

| Setting | Value |
|---|---|
| Framework Preset | Vite |
| Root Directory | `client` |
| Install Command | `npm ci --no-audit` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | 20.x |

The `client/` root directory setting is mandatory. Leaving it unset causes Vercel to run `npm run build` from the repository root, which has no build script and will fail.

---

## Backend Service Assumptions

The `server/` Express backend is deployed independently of Vercel. It is not part of the Vercel project. Key assumptions:

- The frontend locates the backend exclusively via `VITE_API_BASE_URL`. There is no hardcoded URL in the client bundle.
- Each environment (local, preview, production) uses its own backend instance with its own `.env` configuration.
- The backend connects to the Stellar Horizon API and Soroban RPC. Its `STELLAR_HORIZON_TIMEOUT_MS` and `SOROBAN_RPC_TIMEOUT_MS` environment variables control request timeouts (default `10000` ms each).
- There is no shared session or database state between environments. A transaction submitted in the local environment has no effect on the production backend.

---

## Troubleshooting

**Preview deployment fails while production succeeds (or vice versa).**
Compare the environment variables scoped to Production vs Preview in the Vercel dashboard. A missing variable in one scope is the most common cause.

**`client/client/...` path errors in build logs.**
The Vercel Root Directory is set to the repository root instead of `client/`. Update the project settings to `client` and redeploy.

**App shows no yield data after deploy.**
`VITE_API_BASE_URL` is either missing, pointing at localhost (unreachable from Vercel), or pointing at the wrong environment's backend. Update the variable for the affected scope and redeploy.

**Governance page shows wrong contract.**
`VITE_CONTRACT_ID` or `VITE_VAULT_CONTRACT_ID` is set to a testnet ID in a production deployment. Update to the correct mainnet contract ID.
