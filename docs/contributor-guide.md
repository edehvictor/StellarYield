# Contributor Guide

## Issue Labels

### Difficulty labels

| Label | When to apply |
|-------|--------------|
| `difficulty: easy` | Self-contained change, clear acceptance criteria, no cross-cutting concerns. Good for first-time contributors. |
| `difficulty: medium` | Requires understanding of at least one subsystem. May touch multiple files. |
| `difficulty: hard` | Complex design decision, significant refactor, or cross-cutting change across multiple areas. |

### Area labels

Apply one or more `area:` labels to describe which part of the repo the issue touches:

- `area: frontend` — `client/`
- `area: backend` — `server/`
- `area: contracts` — `contracts/`
- `area: docs` — documentation only
- `area: ci` — GitHub Actions / CI config

### How maintainers should apply labels

1. Every new issue should get exactly one `difficulty:` label and at least one `area:` label.
2. Add `good first issue` only when the issue also has `difficulty: easy` **and** a clear, step-by-step acceptance criteria.
3. Labels are defined in `.github/labels.yml`. To sync labels to the repo run:
   ```bash
   gh label import .github/labels.yml
   ```
4. Never remove existing labels not listed in `labels.yml` — only add.

---

## Pre-commit Formatting and Verification

The following formatting, lint, build, and test commands should be run before opening a pull request.

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

## File Encoding

All tracked text files in this repository are UTF-8 (no BOM) with LF line endings. Editors and tooling occasionally re-encode files when copy-pasting from rich text, opening files on Windows, or piping through shells with a non-UTF-8 locale, which is how mojibake (`â€™`, `Â§`, `â€“`) creeps in.

When adding or editing user-facing copy or documentation:

- Configure your editor to save as **UTF-8** without a byte-order mark.
- Prefer plain ASCII for technical content (`->`, `--`, `...`); reserve Unicode typography (`→`, `—`, `…`, `•`) for places where the visual difference matters.
- If you must copy from a rich-text source, paste into a plain-text editor first to strip Word-style smart quotes and dashes.
- Before committing, run `git diff` and look for replacement characters (`�`) or repeating `Ã`/`Â` sequences — those almost always indicate encoding drift rather than intentional content.
