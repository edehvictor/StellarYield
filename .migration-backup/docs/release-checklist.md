# Release Readiness Checklists

This document provides checklists for **Wave contributors** submitting PRs and **maintainers** deploying to production.

---

## Stellar Wave Submission Checklist

Use this checklist **before requesting a review** on your Wave PR. All items must be completed for maintainers to proceed with merge and deployment.

### 1. Issue Linking & Scoping
- [ ] PR description includes `Fixes #ISSUE_NUMBER` to automatically close the issue when merged.
- [ ] PR title clearly matches the issue title (or is a concise summary of the work).
- [ ] PR description briefly explains **what** changed and **why**.
- [ ] This PR addresses only **one** issue; multi-issue PRs are split into separate submissions.

### 2. Build & Continuous Integration
- [ ] ✅ All GitHub Actions CI checks pass:
  - [ ] `Frontend Checks` (lint, test, build) pass or show only advisory warnings
  - [ ] `Backend Checks` (lint, test) pass or show only advisory warnings
  - [ ] `Soroban Contract Checks` (format, clippy, test) pass (if contracts modified)
  - [ ] `Vercel Preview` deployment succeeds
- [ ] No console errors or breaking warnings in the Vercel Preview URL (check F12 → Console).
- [ ] If CI is advisory-only for your change type, you have still run the checks locally and fixed all blocking issues.

### 3. Code Quality & Testing
- [ ] **Frontend changes:** Ran `npm run lint` and `npm run test` locally; all pass.
- [ ] **Backend changes:** Ran `npm run lint` and `npm test` locally with `DATABASE_URL` configured.
- [ ] **Contract changes:** Ran `cargo fmt`, `cargo clippy -D warnings`, and `cargo test` locally.
- [ ] Test coverage is ≥90% for financial or safety-critical logic.
- [ ] No **TODOs** or **FIXME** comments left in production code (move to issues if needed).

### 4. Visual & Responsive Design (Frontend PRs)
- [ ] UI changes include screenshots in the PR description for:
  - [ ] Desktop (1024px+)
  - [ ] Mobile (375px)
  - [ ] Tablet (768px) — optional if identical to desktop
- [ ] Or explicitly marked "No visual changes" with brief explanation (e.g., "Logic refactoring, no UI change").
- [ ] Vercel Preview has been tested in at least two browsers (Chrome + Firefox or Safari).
- [ ] Text contrast, focus states, and touch-target sizes follow accessibility guidelines (see [contributor-guide.md](./contributor-guide.md#accessibility--contrast-guidelines)).

### 5. Documentation
- [ ] **Code comments:** Complex logic, algorithms, or unusual patterns are clearly commented.
- [ ] **NatSpec (Contracts):** Smart contract entry points include `/// @param` and `/// @return` NatSpec comments.
- [ ] **README.md:** If you added new environment variables, contract IDs, or features, the `README.md` has been updated.
- [ ] **Docs folder:** If you added a new feature with setup steps, create a doc in `docs/` or update an existing one.
- [ ] **CHANGELOG:** (Optional, maintainers may handle) If there is a `CHANGELOG.md`, add your change to the unreleased section.

### 6. Manual Smoke Test
- [ ] You have tested the **happy path** of your feature in the Vercel Preview environment:
  - For feature PRs: Navigate to the relevant UI, perform the core action, and verify success.
  - For backend PRs: Test at least one new endpoint with `curl`, Postman, or similar.
  - For contract PRs: Call the new function or method with valid inputs in the test environment.
- [ ] No errors appear in browser console (F12 → Console) or backend logs during testing.

### 7. Security (if applicable)
- [ ] **Frontend:** No hardcoded secrets, API keys, or private data in code or comments.
- [ ] **Backend:** Sensitive operations (auth, payments) are properly gated and logged.
- [ ] **Contracts:** Authorization checks are in place for all sensitive entry points (see [contract-security-checklist.md](./contract-security-checklist.md)).
- [ ] If your PR modifies `contracts/`, review the [Contract Security Checklist](./contract-security-checklist.md) in full.

### 8. PR Template Completion
- [ ] All checkboxes in the **PR template** (`.github/pull_request_template.md`) are completed.
- [ ] **Verification Commands** section has checkmarks for all commands you ran.
- [ ] **UI Snapshot Checklist** is checked appropriately (screenshots provided or "No visual changes" noted).

---

## Maintainer Deployment Checklist

This checklist is for **maintainers** preparing a Wave submission or release for production deployment.

### Pre-Deployment Review

- [ ] All Wave PRs have been reviewed and approved by at least one maintainer.
- [ ] Issue triage dashboard is up-to-date (run `GITHUB_TOKEN=xxx node scripts/issue-triage.js`).
- [ ] Blocked or high-priority issues have been addressed or escalated.

### Vercel Production & Preview Checks

- [ ] Vercel **Preview** deployments are building successfully (check `.github/workflows/`).
- [ ] **Root Directory** in Vercel settings = `client`, **Install** = `npm ci --no-audit`, **Build** = `npm run build`, **Output** = `dist`.
- [ ] Environment variables are correctly scoped:
  - [ ] `VITE_API_BASE_URL` is set in Vercel for **Production** and **Preview** environments.
  - [ ] All other required `VITE_*` variables are set (contract IDs, network passphrase, etc.).
  - [ ] Private secrets are **not** in any `VITE_*` variables (they leak to the browser).
- [ ] **Production** environment variables are **verified** different from **Preview** (if applicable).
  - [ ] Contract IDs point to production-ready contracts.
  - [ ] `VITE_SOROBAN_RPC_URL` points to the correct network (mainnet vs testnet).
  - [ ] `VITE_NETWORK_PASSPHRASE` matches the RPC URL.

### Smoke Tests

- [ ] Run the automated smoke test:
  ```bash
  node scripts/smoke-test.js --report --markdown
  ```
- [ ] Or manually verify:
  - [ ] Frontend homepage loads without console errors.
  - [ ] Backend `/api/health` returns 200 OK.
  - [ ] At least one user-facing API call succeeds (e.g., fetch yields data).
- [ ] Screenshots or notes from smoke testing are recorded for deployment notes.

### Backend & Contract Deployment (if applicable)

- [ ] Backend deployment is healthy:
  - [ ] Logs show no startup errors or missing environment variables.
  - [ ] All new database migrations have been applied (`prisma db push`).
  - [ ] Health endpoint responds successfully.
- [ ] Smart contracts (if deployed):
  - [ ] Contract addresses are correctly recorded and documented.
  - [ ] **Network** is verified (testnet vs mainnet).
  - [ ] **Address format** matches the network (e.g., `C` for mainnet, `T` for testnet on Stellar).
  - [ ] Environment variables referencing contract IDs have been updated in all tiers (dev, staging, prod).

### Documentation & Release Notes

- [ ] PR(s) reference related issues using `Fixes #ISSUE_NUMBER`.
- [ ] Deployment notes are recorded (new contract addresses, environment changes, etc.).
- [ ] Release notes or changelog is prepared (if applicable).
- [ ] Any **breaking changes** are clearly documented and communicated to users.

### Post-Deployment Smoke Checks

- [ ] **Production environment** is tested:
  - [ ] Frontend loads and basic navigation works.
  - [ ] At least one API-dependent feature works (e.g., loading yields dashboard).
  - [ ] Wallet connection and transaction signing still function.
- [ ] **Logs are monitored** for errors in the first 10 minutes after deployment.
- [ ] **Users are notified** of any planned maintenance or breaking changes (if applicable).

### Rollback Plan

- [ ] **Frontend rollback:** Redeploy the last known good build via Vercel Deployments → Promote to Production.
- [ ] **Backend rollback:** Documented in your hosting platform's rollback procedure.
- [ ] **Contracts:** If contract deployment is incorrect, halt frontend updates and follow the contract remediation plan in [contract-security-checklist.md](./contract-security-checklist.md).

---

## Deployment Infrastructure Checks

Maintain these settings for stable deployments:

### Vercel Project Settings

| Setting | Value | Notes |
| --- | --- | --- |
| Root Directory | `client` | The frontend build source |
| Install Command | `npm ci --no-audit` | Matches CI for reproducibility |
| Build Command | `npm run build` | Vite production build |
| Output Directory | `dist` | Vite output folder |
| Node.js Version | `20.x` | Matches `.github/workflows/ci.yml` and `package.json` |

### Environment Variable Scope

| Variable | Scope | Priority | Purpose |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | Production, Preview, Development | Highest | Backend URL; required for preview to work |
| `VITE_SOROBAN_RPC_URL` | Production, Preview | High | Soroban network endpoint |
| `VITE_NETWORK_PASSPHRASE` | Production, Preview | High | Stellar network identifier |
| `VITE_*_CONTRACT_ID` | Production, Preview | High | Smart contract addresses |
| `VITE_VAULT_TOKEN_*` | Production, Preview | Medium | Token metadata |
| Others (`VITE_APP_URL`, etc.) | As needed | Low | Optional integrations |

**Important:** Set each variable **per environment** in Vercel. A variable set only for Production will **not** auto-inherit to Preview (Vercel scopes them separately).

---

## Automated Release Smoke Report (GitHub Actions)

After deploying frontend and backend, maintainers can run the release smoke report workflow from GitHub Actions or locally.

1. Go to **Actions → Release smoke report → Run workflow**.
2. Provide:
   - `frontend_url` (e.g., `https://stellaryield.vercel.app`)
   - `backend_url` (e.g., `https://api.example.com`)
   - Optional: `issue_or_pr_number` to post the report as a comment.
3. The workflow checks:
   - [ ] Backend `/api/health` returns 200.
   - [ ] Backend `/api/yields` (or configured path) returns data.
   - [ ] Frontend `/` loads successfully.
   - [ ] Frontend static assets (e.g., `favicon.svg`) are reachable.
4. Results are posted in the job summary and optionally as an issue or PR comment.

### Local Equivalent

```bash
FRONTEND_URL="https://stellaryield.vercel.app" \
BACKEND_URL="https://api.example.com" \
  node scripts/smoke-test.js --report --markdown
```

- Portable report only: `node scripts/smoke-test.js --report --markdown`.
- Default checks expect HTTP 200 on `BACKEND_HEALTH_PATH` (default `/api/health`), `BACKEND_YIELDS_PATH` (default `/api/yields`), frontend `/`, and `FRONTEND_ASSET_PATH` (default `/favicon.svg`). Override via workflow dispatch inputs or the same-named environment variables.

---

## Reference Links

- [CONTRIBUTING.md](../CONTRIBUTING.md) — How to contribute and run local checks
- [contributor-guide.md](./contributor-guide.md) — CI workflows and local verification
- [contract-security-checklist.md](./contract-security-checklist.md) — Security review for contracts
- [GitHub Actions Workflows](../.github/workflows/)
- [Vercel Deployment Settings](../README.md#vercel-deployment-settings) in README.md

## Rollback Notes

- If the frontend deployment is unhealthy, redeploy the last known good Vercel build from the Vercel dashboard.
- If the backend release is unhealthy, roll back to the previous stable deployment in the hosting platform.
- If a contract deployment is incorrect, stop frontend promotion of the new addresses and follow the contract-specific remediation plan before resuming traffic.

## Documentation

- Keep this checklist linked from `README.md` and `CONTRIBUTING.md`.
- Update the checklist when deployment tooling, approval policy, or smoke-test expectations change.
