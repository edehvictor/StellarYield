# Pre-commit Formatting and Verification Guide

This guide lists the formatting, lint, build, and test commands contributors should run before opening a pull request.

## Rust Contracts

Run these commands from `contracts/`:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Use `cargo fmt --all` locally if you need to apply formatting fixes before re-running the check.

## Frontend

Run these commands from `client/`:

```bash
npm ci
npm run lint
npm run build
npm run test
```

## Backend

Run these commands from `server/`:

```bash
npm ci
npm run lint
npm run build
npm test
```

## README Verification

Run this command from the repository root to verify the setup and verification commands documented in `README.md`:

```bash
node scripts/verify-readme-commands.js
```

## Windows PowerShell Troubleshooting

If PowerShell blocks npm scripts with an execution policy error, use one of these options:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Or run npm from `cmd.exe` for the current session:

```powershell
cmd /c "npm run lint"
```

The process-scoped policy change only affects the current shell window and is usually the safest option for local development.

## Finding CI Artifacts

When the pull request workflow fails, GitHub Actions uploads failure artifacts with a 7-day retention period. Open the workflow run, scroll to the run summary, and download the files listed in the **Artifacts** section.
