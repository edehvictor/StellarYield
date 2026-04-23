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
npm run dev
```

The frontend runs on `http://localhost:5173`.

### Backend Setup

```bash
cd server
npm ci
npm run dev
```

The backend runs on `http://localhost:3001`.

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

- [Contributing Guide](./CONTRIBUTING.md)
- [Pre-commit Formatting and Verification Guide](./docs/contributor-guide.md)
- [Release Checklist](./docs/release-checklist.md)

## Drips Wave

StellarYield is participating in the Stellar Wave Program via Drips. Contributors can pick up open issues, submit focused pull requests, and validate their work locally with the commands above before opening a PR.
