# Frontend Environment Variable Reference

The StellarYield client is built with [Vite](https://vitejs.dev/), which only exposes variables prefixed with `VITE_` to the browser bundle. Every variable listed here is **public** by design — never put private keys, signing secrets, or backend credentials in a `VITE_` variable. They become part of the shipped JavaScript.

Place values in `client/.env.local` during development. Production values are configured in the Vercel dashboard for each environment (Production, Preview, Development) and must be re-set if the project is moved.

## How to use this file

1. Copy [`client/.env.example`](../client/.env.example) to `client/.env.local`.
2. Fill in the required variables for your network.
3. Override optional values only when you need to point the client at a non-default backend, RPC, or contract set.
4. Restart `npm run dev` after editing `.env.local` — Vite snapshots env vars at start-up.

## Required for local development

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:3001` | Base URL for the StellarYield backend REST API. Used by every `getApiBaseUrl()` caller. |
| `VITE_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint the frontend submits transactions to. Change when targeting mainnet. |
| `VITE_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Stellar network passphrase. Must match the RPC URL (testnet vs mainnet). |

## Soroban contract IDs

The client only needs to know about contracts it interacts with directly. Leave a variable blank to disable the feature in the UI; runtime checks will surface a "not configured" state instead of crashing.

| Variable | Description |
| --- | --- |
| `VITE_CONTRACT_ID` | Primary vault contract ID. Required to load any vault data. |
| `VITE_VAULT_CONTRACT_ID` | Newer override for `VITE_CONTRACT_ID`. When both are set, this one wins. |
| `VITE_ZAP_CONTRACT_ID` | One-click "zap" deposit router contract. |
| `VITE_VESTING_CONTRACT_ID` | Vesting / lockup contract used by the vesting dashboard. |
| `VITE_STRATEGY_CONTRACT_ID` | Active yield-strategy contract. |
| `VITE_TOKEN_CONTRACT_ID` | Vault share-token (SAC) contract. |
| `VITE_VAULT_TOKEN_CONTRACT_ID` | Underlying vault deposit token (usually USDC). |
| `VITE_GOVERNANCE_CONTRACT_ID` | Governance / voting contract. |
| `VITE_EMISSION_CONTROLLER_CONTRACT_ID` | Rewards emission controller. |
| `VITE_LIQUID_STAKING_CONTRACT_ID` | Liquid staking contract. |
| `VITE_STABLESWAP_CONTRACT_ID` | Stableswap pool contract. |

### Vault token presentation

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_VAULT_TOKEN_SYMBOL` | `USDC` | Symbol shown next to vault token amounts. |
| `VITE_VAULT_TOKEN_DECIMALS` | `7` | Decimals for the vault token. Must match the on-chain SAC. |

### Zap asset metadata

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_ZAP_METADATA_FROM_API` | `true` | When `"true"`, the client fetches zap metadata from the backend; otherwise it uses the local JSON below. |
| `VITE_ZAP_ASSETS_JSON` | _empty_ | JSON-encoded list of zap assets used when API loading is disabled. |
| `VITE_XLM_SAC_CONTRACT_ID` | _empty_ | SAC contract for XLM. |
| `VITE_USDC_SAC_CONTRACT_ID` | _empty_ | SAC contract for USDC. |
| `VITE_AQUA_SAC_CONTRACT_ID` | _empty_ | SAC contract for AQUA. |

## Optional integrations

These variables are safe to leave blank in development. Features that depend on them gracefully disable themselves.

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_APP_URL` | `https://stellaryield.vercel.app` | Canonical site URL used for share links and OG metadata. |
| `VITE_OFFRAMP_BASE_URL` | `https://api.moonpay.com` | Off-ramp provider base URL. Override when using a sandbox. |
| `VITE_OFFRAMP_API_KEY` | _empty_ | Public off-ramp partner key. Note: even though "API key" sounds private, the off-ramp partner issues a publishable key intended for the browser; do not put a server-side secret here. |
| `VITE_GOOGLE_CLIENT_ID` | _empty_ | Google OAuth client ID for Sheets export. |
| `VITE_GOOGLE_CLIENT_SECRET` | _empty_ | Google OAuth client secret. **Only set this for local testing**; production builds must use a backend-mediated OAuth flow rather than shipping the secret in the bundle. |

## Example `.env.local`

```dotenv
# Required
VITE_API_BASE_URL=http://localhost:3001
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Vault — testnet defaults
VITE_CONTRACT_ID=CC...
VITE_ZAP_CONTRACT_ID=CC...
VITE_VAULT_TOKEN_CONTRACT_ID=CC...
VITE_VAULT_TOKEN_DECIMALS=7
VITE_VAULT_TOKEN_SYMBOL=USDC

# Optional integrations
VITE_APP_URL=http://localhost:5173
# VITE_OFFRAMP_API_KEY=
# VITE_GOOGLE_CLIENT_ID=
```

## Production expectations

- All required variables above must be set in Vercel for both the Production and Preview environments.
- Contract IDs must point at the network selected by `VITE_NETWORK_PASSPHRASE` and `VITE_SOROBAN_RPC_URL`. Mixing testnet contracts with mainnet RPC (or vice versa) is the most common deploy-time bug.
- Do not promote a Preview build to Production without verifying the environment-specific values; Vercel scopes variables per environment so a missing Production override silently inherits the Preview value.
- For rotation rollouts, change `VITE_VAULT_CONTRACT_ID` first, redeploy, then retire `VITE_CONTRACT_ID` in a follow-up release once the override has been verified.
