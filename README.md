# StellarYield

> Notice: the original Vercel domain submitted during Drips Wave review was claimed by a squatter. The current live deployment is [stellaryield.vercel.app](https://stellaryield.vercel.app).

StellarYield is a Stellar-native DeFi dashboard and automated vault project. The repository includes a Vite frontend in `client/`, an Express backend in `server/`, and Soroban smart contracts in `contracts/`.

## Repository Layout

- `client/` - React + Vite frontend
- `server/` - Node.js + Express backend
- `contracts/` - Soroban smart contracts and Rust workspace
- `docs/` - contributor and release documentation
- `.github/workflows/ci.yml` - pull request validation workflow

## Getting Started

### Prerequisites

- Node.js 20+
- npm 10+
- Rust stable toolchain
- Soroban CLI for contract work

### Clone the Repository

```bash
git clone https://github.com/YOUR_GITHUB_NAME/StellarYield.git
cd StellarYield
```

### Frontend Setup

```bash
cd client
npm ci
cp .env.example .env.local
npm run dev
```

The frontend runs on `http://localhost:5173`.

### Backend Setup

```bash
cd server
npm ci
cp .env.example .env
npm run dev
```

The backend runs on `http://localhost:3001`.

#### Environment Variables

- `STELLAR_HORIZON_TIMEOUT_MS`: Timeout for Horizon API calls in milliseconds (default: `10000`)
- `SOROBAN_RPC_TIMEOUT_MS`: Timeout for Soroban RPC API calls in milliseconds (default: `10000`)
The example env files document required and optional values. Keep real secrets
out of git; frontend values must be public `VITE_` values only.

For the **full list of `VITE_` variables the client reads** — including required values, contract IDs, optional integrations, and a production deployment checklist — see [docs/frontend-env-reference.md](./docs/frontend-env-reference.md).

### API Documentation

The backend provides OpenAPI documentation:

- **Interactive Swagger UI**: http://localhost:3001/api/openapi/docs
- **Raw OpenAPI spec (YAML)**: http://localhost:3001/api/openapi

These are automatically available when the backend is running. The Swagger UI provides a visual, interactive interface to explore all API endpoints, request parameters, and response schemas.

### Contract Verification

```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Verification Commands

### Client

```bash
cd client
npm run lint
npm run build
npm run test
```

### Server

```bash
cd server
npm run lint
npm run build
npm test
```

### Contracts

```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

### README Verification

The CI workflow also checks that the documented setup and verification commands in this README stay in sync with the repo:

```bash
node scripts/verify-readme-commands.js
```

## CI Failure Artifacts

When the pull request workflow fails, GitHub Actions uploads frontend failure artifacts and contract test logs for a short retention window. Open the failed workflow run in the GitHub Actions tab and look for the **Artifacts** section near the bottom of the run summary.

## Vercel Deployment Settings

The frontend is deployed via Vercel. To avoid the recurring `client/client/...` path failures that have appeared in past preview deployments, the Vercel project must be configured against the `client/` directory and not the repository root. The committed `vercel.json` already encodes the install, build, and output paths *relative to that root*, so misconfiguring the Vercel root re-introduces the doubled path.

Use these values when creating or auditing the Vercel project:

| Setting              | Value                                             |
| -------------------- | ------------------------------------------------- |
| Framework Preset     | Vite                                              |
| Root Directory       | `client`                                          |
| Install Command      | `npm ci --no-audit`                               |
| Build Command        | `npm run build`                                   |
| Output Directory     | `dist`                                            |
| Node.js Version      | 20.x                                              |

For a full breakdown of how local, preview, and production environments differ — including backend assumptions and common failure modes — see [docs/deployment-environment-matrix.md](./docs/deployment-environment-matrix.md).

These match the committed [`vercel.json`](./vercel.json) at the repository root. Vercel resolves the install/build/output paths *inside* the configured Root Directory, so leaving the root unset (or pointing it at the repo root) makes Vercel run `npm run build` from a folder that has no `build` script.

### Troubleshooting

- **Build fails with `client/client/...` paths.** The Vercel Root Directory is set to the repo root instead of `client`. Update the project settings, redeploy, and confirm the build logs now start with `Running install command: npm ci --no-audit` inside `client/`.
- **Preview deployment fails while production succeeds (or vice versa).** Compare the **Environment Variables** scoped to Production vs Preview in the Vercel dashboard. Frontend builds only see variables prefixed `VITE_`; anything else is invisible to the client bundle. Re-promote a known-good build from the **Deployments** tab while you investigate.
- **Custom domain stuck on a stale deployment.** Re-promote the desired deployment from the Vercel dashboard or roll back via the **Deployments → … → Promote to Production** menu. See [`docs/release-checklist.md`](./docs/release-checklist.md) for the documented rollback path.
- **Missing assets in production.** Confirm the asset lives under `client/public/` (served at the site root) or is imported from `client/src/` so Vite bundles it. Assets placed at the repo root are not picked up by the build.

## Contributor and Release Docs

   The mock API will be available at http://localhost:3001

## 🧪 Post-deploy smoke test
After deploying the frontend + backend, run the included smoke test to validate basic reachability.

```bash
FRONTEND_URL="https://your-frontend-url" \
BACKEND_URL="https://your-backend-url" \
bash scripts/smoke-test.sh
```

- **Checks**: `GET /api/yields`, `GET /api/metrics`, and the frontend root.
- **Config**: `FRONTEND_URL` and `BACKEND_URL` environment variables.
🌊 Contributing via Drips Wave
We are proudly participating in the Stellar Wave Program via Drips! We are actively looking for Web3 full-stack and Rust developers.
Check our open issues labeled `Stellar Wave`, apply via the Drips App, and submit your PR to earn rewards funded by the Stellar Development Foundation!
- [Contributing Guide](./CONTRIBUTING.md)
- [Pre-commit Formatting and Verification Guide](./docs/contributor-guide.md)
- [Release Checklist](./docs/release-checklist.md)

## Drips Wave

StellarYield is participating in the Stellar Wave Program via Drips. Contributors can pick up open issues, submit focused pull requests, and validate their work locally with the commands above before opening a PR.

---

## ✅ Post-deploy smoke test

After merge/deploy, you can quickly verify the public app + API are reachable:

```bash
# Unix/Linux/macOS (Bash)
npm run smoke-test

# Windows/Cross-platform (Node.js)
npm run smoke-test:node
```

### Configuration

Override targets via environment variables:

```bash
# Unix/Linux/macOS
FRONTEND_URL="https://stellaryield.vercel.app" \
BACKEND_URL="https://your-backend.example.com" \
npm run smoke-test

# Windows PowerShell
$env:FRONTEND_URL="https://stellaryield.vercel.app"
$env:BACKEND_URL="https://your-backend.example.com"
npm run smoke-test:node

# Windows Command Prompt
set FRONTEND_URL=https://stellaryield.vercel.app
set BACKEND_URL=https://your-backend.example.com
npm run smoke-test:node
```

Optional path overrides:

- `BACKEND_HEALTH_PATH` (default: `/api/health`)
- `BACKEND_YIELDS_PATH` (default: `/api/yields`)
- `FRONTEND_ASSET_PATH` (default: `/favicon.svg`)

### CI Usage

Both smoke test variants support the same environment variables and produce identical output. The Node.js version (`smoke-test:node`) is recommended for CI environments and Windows contributors as it has no Bash dependency.

StellarYield is participating in the Stellar Wave Program via Drips. Contributors can pick up open issues, submit focused pull requests, and validate their work locally with the commands above before opening a PR.
