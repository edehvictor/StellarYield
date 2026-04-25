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

The example env files document required and optional values. Keep real secrets
out of git; frontend values must be public `VITE_` values only.

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
Check our open issues labeled Stellar Wave, apply via the Drips App, and submit your PR to earn rewards funded by the Stellar Development Foundation!
- [Contributing Guide](./CONTRIBUTING.md)
- [Pre-commit Formatting and Verification Guide](./docs/contributor-guide.md)
- [Release Checklist](./docs/release-checklist.md)

## Drips Wave

---

## ✅ Post-deploy smoke test

After merge/deploy, you can quickly verify the public app + API are reachable:

```bash
npm run smoke-test
```

### Configuration

Override targets via environment variables:

```bash
FRONTEND_URL="https://stellaryield.vercel.app" \
BACKEND_URL="https://your-backend.example.com" \
npm run smoke-test
```

Optional path overrides:

- `BACKEND_HEALTH_PATH` (default: `/api/health`)
- `BACKEND_YIELDS_PATH` (default: `/api/yields`)
- `FRONTEND_ASSET_PATH` (default: `/favicon.ico`)

StellarYield is participating in the Stellar Wave Program via Drips. Contributors can pick up open issues, submit focused pull requests, and validate their work locally with the commands above before opening a PR.
