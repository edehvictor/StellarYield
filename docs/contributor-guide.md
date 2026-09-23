# Contributor guide: CI checks, local verification, and getting help

This document maps [GitHub Actions workflows](../.github/workflows/) to what they validate, whether a failed run **blocks** merging (as written in the workflows), and how to reproduce checks locally. Repository **branch protection** may require a subset of checks; if a check is green in Actions but merge is still blocked, confirm which checks are mandatory under **Settings → Branches** in GitHub.

---

## Setup Doctor

Before debugging a confusing local test or build failure, run the setup doctor:

```bash
node scripts/setup-doctor.js
# or
npm run setup:doctor
```

It checks three things and prints a remediation command for anything it finds missing:

1. **Toolchain** — Node.js 20+, npm 10+ (blocking: nothing in this repo runs without them), and Rust/cargo/the Stellar (or Soroban) CLI (recommended, only needed for `contracts/` work).
2. **Workspace dependencies** — whether `node_modules` exists in each npm workspace (`client/`, `server/`, `contracts/`, `backend/keepers/`, `backend/rewards/`, `packages/sdk/`). Missing ones print the exact `cd <dir> && npm ci` to run.
3. **Environment files** — whether each workspace's `.env.example` is present (its absence is a blocking, corrupted-checkout signal) and whether the real `.env`/`.env.local` derived from it exists yet.

Output uses `✅` for OK, `⚠️` for a non-blocking gap relevant only to certain workspaces, and `❌` for a blocking issue. The script exits non-zero only when a `❌` is present — a fresh clone with no `node_modules` installed anywhere is expected to show several `⚠️` lines and still exit `0`; that's the tool telling you what to run next, not that anything is broken. See [docs/deployment-environment-matrix.md](./deployment-environment-matrix.md) for what to put in each `.env` file once it's copied.

---

## Quick reference: blocking vs advisory

The table below reflects **`continue-on-error`**, conditional `if:` steps, and job-level settings in the workflow files—not the Vercel dashboard or optional org-level rules.

| Area | Workflow / source | Blocks PR in YAML? | Notes |
|------|-------------------|---------------------|-------|
| **Backend** | `ci.yml` → *Backend Checks* | **Usually yes** | `npm test`, `prisma generate`, and `prisma db push` fail the job. Backend **lint** uses `continue-on-error: true` (advisory only in CI). |
| **Frontend** | `ci.yml` → *Frontend Checks* | **Partially** | **Tests** failing fail the job. **Lint** (`lint:ci-scope`) and **build** use `continue-on-error: true` (advisory in CI). Prefer running full `npm run lint` and `npm run build` locally before pushing. |
| **Contracts** | `ci.yml` → *Soroban Contract Checks* | **No** | Entire job sets `continue-on-error: true`. Formatting (`cargo fmt`) still runs without that flag on the step—treat contract hygiene as **required by policy** even when the job is lenient. |
| **Docs / README** | `ci.yml` → *README Command Verification* | **No** | Job-level `continue-on-error: true`. |
| **Generated Files** | `ci.yml` → *Generated Files Guard* | **Yes** | Blocks if `issue.md` or `pr.md` are present in the branch diff. See [Generated issue scripts](#generated-issue-scripts) below. |
| **Security (Rust)** | `security.yml` | **Mixed** | Jobs post **PR comments** (`cargo-audit`, security-focused Clippy, Soroban pattern scan). Explicit **fail-on-push** guards exist for some steps; PRs rely on visibility in comments rather than failing the audit job by default—still fix reported issues. |
| **CodeQL** | `codeql.yml` | **If required** | Fails when analysis fails unless overridden. Typically treated as blocking when enabled for the repo. Hard to replicate fully offline. |
| **Dependency Review** | `dependency-review.yml` | **Soft** | Runs only for PRs from the **same** repository (not forks). The review step uses `continue-on-error: true` so missing Dependency Graph support does not hard-fail CI. High-severity findings are still surfaced in the PR. |
| **Vercel** | Vercel GitHub integration | **Project-dependent** | Not defined in-repo. Failed **preview** or **production** builds show as checks on the PR if the project is linked. Root Directory must be **`client`** (see [README](../README.md#vercel-deployment-settings)). |
| **IPFS preview** | `ipfs-deploy.yml` | **Varies** | Builds `client/` and may pin to IPFS when secrets are configured. Does not replace Vercel checks. |

**Advisory (for PRs, in-repo configuration):** backend lint (CI), frontend scoped lint + build (CI), whole contracts CI job (job-level), README verifier job, Dependency Review step, and the advisory-style security commentary jobs. Treat advisory checks as signals—fix them unless a maintainer explicitly waives them.

---

## Backend (`ci.yml` — Backend Checks)

**What it does:** Installs `server/` dependencies, runs ESLint (non-blocking in CI), generates the Prisma client, applies `prisma db push` against a PostgreSQL 15 service, and runs `npm test`.

**Local parity (needs PostgreSQL):**

```bash
# Terminal 1: PostgreSQL 15 (matches CI service image)
docker run --rm --name stellaryield-pg \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=stellaryield_test \
  -p 5432:5432 \
  postgres:15
```

```bash
cd server
export DATABASE_URL="postgresql://test:test@localhost:5432/stellaryield_test"
npm ci --no-audit --prefer-offline
npm run lint    # stricter locally than CI; CI treats lint as advisory
npx prisma generate
npx prisma db push
npm test
```

**Reading failures:** Expand **Backend Checks → Run backend tests** (or Prisma steps) in the Actions log. Database connection errors usually mean `DATABASE_URL` or Postgres availability differs from CI.

---

## Frontend (`ci.yml` — Frontend Checks)

**What it does:** Installs `client/` deps, runs `npm run lint:ci-scope` (ESLint limited to `src/features/zap`), runs `npm test`, then `npm run build`. Tests failing **fail** the job; lint and build steps use `continue-on-error: true` in CI.

**Recommended local commands (stricter than CI minimum):**

```bash
cd client
npm ci --no-audit --prefer-offline
npm run lint
npm run test
npm run build
```

**Reading failures:** On failure, the workflow may upload **Artifacts** (e.g. `frontend-failure-artifacts-*`) containing `frontend-test.log` and `frontend-build.log`. Open the run summary → **Artifacts** at the bottom of the page.

---

## UI Snapshots & Visual Review Checklist

Frontend PRs that modify UI **must** include screenshots or video recordings of the changes. This ensures reviewers can validate visual consistency, responsive design, and accessibility before merging.

### When UI snapshots are required:

✅ **Always include snapshots for:**
- Changes to CSS, layouts, or styling (colors, fonts, spacing)
- New React components or modifications to existing ones
- Changes to responsive breakpoints or media queries
- New forms, modals, dialogs, dropdowns, or interactive elements
- Animation or transition changes
- Icon or imagery updates

❌ **Not required for:**
- Pure logic refactoring with no visual impact
- Changes to non-visual utility functions or API calls
- Backend-only changes (no frontend code modified)
- **Exception:** If you touch `/client` but have zero visual changes, explicitly state **"No visual changes"** in the PR description and check the box in the PR template.

### Viewport requirements:

Provide screenshots for the **minimum** three standard breakpoints:

| Viewport | Width | Device Type | Checklist |
|----------|-------|-------------|-----------|
| Desktop | 1024px+ | Laptop/Desktop | Full layout, menu expanded, all features visible |
| Tablet | 768px | iPad/Tablet | Navigation may collapse or shift; check readability |
| Mobile | 375px | iPhone SE/Mobile | Smallest breakpoint; text should not overflow; buttons touch-friendly |

**Why these sizes?** They cover the CSS media queries typically used in StellarYield and represent real device breakpoints.

### How to capture screenshots:

**Browser DevTools (recommended for web):**
1. Open **DevTools** (F12 / Cmd+I)
2. Click **Toggle device toolbar** (or Ctrl+Shift+M)
3. Select a device or manually set width (Desktop: 1024px, Tablet: 768px, Mobile: 375px)
4. Interact with the UI, scroll if needed
5. **Capture:** On Mac `Cmd+Shift+4` → select area. On Windows `Win+Shift+S`. On Linux `gnome-screenshot`.

**Screen recording (for interactions, animations, hover states):**
- **Mac:** QuickTime Player (File → New Screen Recording)
- **Windows:** Win+G → Xbox Game Bar → Record
- **Linux:** OBS Studio
- **Online:** Loom (no install, free), or Screencastify
- Upload a Gist video link or create an MP4 and attach to the PR.

### How to add snapshots to your PR:

1. **In PR description,** include a **Screenshots** section:
   ```markdown
   ## Screenshots
   
   ### Desktop (1024px)
   ![Desktop view](https://user-images.githubusercontent.com/...)
   
   ### Mobile (375px)
   ![Mobile view](https://user-images.githubusercontent.com/...)
   ```

2. **Direct upload to PR:** Drag-and-drop images into the PR description or use GitHub's attachment dialog.

3. **Vercel Preview:** In your PR checks, click the **Preview** link from Vercel to see the live version. This is the **gold standard**—reviewers can interact with the actual page instead of static screenshots.

### If there are no visual changes:

If you modify `/client` but the UI is unchanged (e.g., refactoring API logic, fixing accessibility without visual change):

```markdown
## UI Snapshot Checklist
- [x] No visual changes

This PR refactors the wallet context to improve performance; 
no changes to rendered output or styling.
```

### Reviewer expectations:

- **Visual regression:** Does the layout look correct? Are colors, spacing, typography consistent?
- **Responsive design:** Do all three viewports (desktop, tablet, mobile) render correctly?
- **Interactive states:** Hover, focus (keyboard), active, and disabled states all visible?
- **Accessibility:** Text contrast high enough? Focus indicators clear? Buttons and links properly sized?
- **Across browsers:** If possible, reviewers may test in Firefox, Chrome, Safari. Make responsive design a priority.

### Accessibility & contrast guidelines:

When providing UI snapshots, ensure:

- **Text contrast:** Minimum 4.5:1 for normal text, 3:1 for large text (WCAG AA).
  - Use a tool like [WebAIM contrast checker](https://webaim.org/resources/contrastchecker/).
- **Focus states:** Keyboard navigation must be visible (outline or highlight around focused element).
- **Color alone:** Do not convey information using color alone; use patterns, icons, or text labels as well.
- **Touch targets:** Buttons and interactive elements should be at least 44x44 pixels (mobile).
- **Readable fonts:** Use sans-serif fonts, sufficient line-height (≥1.5), and avoid all-caps for body text.

For more accessibility guidance, see the [Web Content Accessibility Guidelines (WCAG 2.1)](https://www.w3.org/WAI/WCAG21/quickref/) or consult your design system.

### Tools for responsive testing:

- **Google Chrome DevTools:** Built-in device emulation (see above)
- **Firefox DevTools:** Responsive Design Mode (Ctrl+Shift+M)
- **BrowserStack:** Cloud-based testing on real devices (paid)
- **Responsively App:** Standalone tool for multi-viewport testing (free, cross-platform)
- **Vercel Preview:** Test the actual deployed preview URL in real browsers

---



**What it does:** `cargo fmt --check`, `cargo clippy` (Clippy step is `continue-on-error: true` in CI), `cargo test --workspace` with logs uploaded on test failure.

**Local commands (stricter Clippy than CI; matches [README](../README.md) guidance):**

```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

**Optional fuzzing** (see [CONTRIBUTING.md](../CONTRIBUTING.md)):

```bash
cd contracts
cargo test --test fuzz_tests -- --nocapture
```

**Reading failures:** Download **`contract-test-logs-*`** from the run’s **Artifacts** and open `contract-test.log`.

**Also read:** [Contract security checklist](./contract-security-checklist.md) and `security.yml` (below) for dependency audit and Soroban pattern comments on PRs.

---

## Security workflows

### `security.yml` (contract path filters)

When `contracts/**` changes, this workflow can run **cargo-audit** (results in an artifact and a PR comment), **security-focused Clippy** on `yield_vault` (stricter than default Clippy; findings summarized on the PR), and a **custom Soroban pattern** scan (e.g. `unsafe`, `panic!`, `use std::` in contracts). Engage with the bot comments even when the job remains green.

**Local parity (examples):**

```bash
cd contracts
cargo install --locked cargo-audit   # once
cargo audit

cargo clippy -p yield_vault --all-targets -- \
  -D clippy::unwrap_used \
  -D clippy::expect_used \
  -D clippy::panic \
  -D clippy::arithmetic_side_effects \
  -D clippy::indexing_slicing
```

### `codeql.yml`

CodeQL runs the **JavaScript/TypeScript** security-extended suite with autobuild. Failures appear under the CodeQL check on the PR. Use the CodeQL **Security** tab / annotations for remediation; there is no single one-line local equivalent.

### `dependency-review.yml`

Runs on pull requests to `main` for **non-fork** PRs. Summarizes dependency and license changes. The action uses `continue-on-error: true` so infrastructure gaps do not block merges, but you should still address reported **high** severity items when they appear.

---

## Vercel checks

Vercel is configured outside this repo’s workflow files. When the GitHub integration is enabled, **preview deployments** attach checks to PRs.

**Local preview of what Vercel runs** (aligned with [`vercel.json`](../vercel.json), which assumes Root Directory **`client`**):

```bash
cd client
npm ci --no-audit
npm run build
```

If the live check fails:

- Confirm **Root Directory** = `client`, **Install** = `npm ci --no-audit`, **Build** = `npm run build`, **Output** = `dist`, Node **20.x**.
- Compare **Production** vs **Preview** **environment variables**; only `VITE_*` variables affect the bundled client.

See [README — Vercel Deployment Settings](../README.md#vercel-deployment-settings) and [docs/deployment-environment-matrix.md](./deployment-environment-matrix.md) if linked from your tree.

---

## Other workflows (short)

| File | Role |
|------|------|
| `ipfs-deploy.yml` | Builds `client/` and may publish IPFS previews when Pinata secrets exist. |
| `stale.yml` | Repository housekeeping; not a contributor gate. |
| `ci.yml` → *Formal Verification (Kani)* | Manual **workflow_dispatch** only; not part of default PR CI. |

---

## README command verification

CI runs:

```bash
node scripts/verify-readme-commands.js
```

from the repository root. It checks that documented commands and doc links in `README.md` stay consistent with the repo (including this file).

---

## Generated issue scripts

The files `issue.md` and `pr.md` are **local operational artifacts** — auto-generated summaries that maintainers and contributors use to track issue scope and compose PR descriptions during active development. They must **never** be committed to the repository.

### Guard

CI runs `node scripts/check-generated-files.js` from the repository root as part of `ci.yml` → *Generated Files Guard*. It compares the branch diff against `origin/main` and fails if either filename appears in any changed path. This job is **blocking**: a red guard prevents merging.

### Where local maintainer scripts live

Repository-local scripts that are safe to commit belong under `scripts/`. The following are already committed and CI-safe:

| Script | Purpose |
|--------|---------|
| `scripts/issue-triage.js` | Maintainer issue triage summary via GitHub Search API |
| `scripts/verify-readme-commands.js` | Verifies README commands match package.json scripts |
| `scripts/validate-workspace.js` | Runs env var consistency checks |
| `scripts/smoke-test.sh` / `scripts/smoke-test.js` | Backend / frontend endpoint smoke tests |
| `scripts/setup-doctor.js` | Toolchain and workspace setup checker |
| `scripts/maintainer_saved_searches.sh` | Maintainer triage shortcut links |
| `scripts/check-frontend-env.js` | CI guardrail for unsafe VITE_ secrets |
| `scripts/check-env-vars.js` / `scripts/check-env-drift.ts` | Environment variable consistency checkers |
| `scripts/check-generated-files.js` | CI guardrail for accidental `issue.md` / `pr.md` commits |

Generated helpers like `issue.md` and `pr.md` that summarize issue scope or compose PR bodies are **not** under `scripts/` because they are ephemeral, author-specific, and should never be reviewed or merged. Keep them in the repository root (where `.gitignore` already excludes them) or in a temporary working directory outside the repo.

### Recovering from an accidental commit

If `issue.md` or `pr.md` end up in a branch despite the `.gitignore` entry (e.g. via `git add --force`), remove them from tracking:

```bash
git rm --cached issue.md pr.md
git commit -m "chore: remove accidentally committed generated files"
```

Then rebase or create a new PR branch from a clean point on `main`.

---

## Running GitHub Actions locally

The maintainers do not commit a pinned `act` configuration. Two practical options:

### 1. Command parity (recommended)

Use the **copy-paste blocks** in this document for backend, frontend, contracts, and `verify-readme-commands.js`. That matches what CI stresses without Docker-in-Docker complexity.

### 2. `act` (optional)

[nektos/act](https://github.com/nektos/act) runs workflows in Docker containers. Install (e.g. `brew install act`), then from the repo root:

```bash
act --list                                   # enumerate workflows/events
act pull_request -W .github/workflows/ci.yml -j backend   # example: backend job only
```

**Limitations:** Services (Postgres), secrets, caching, and some GitHub APIs differ from `github.com`. If `act` fails but push checks pass—or the opposite—trust the upstream Actions run after reproducing commands locally.

To trigger your branch’s workflow run on GitHub:

```bash
gh workflow run CI --ref "$(git branch --show-current)"
# or push your branch — pull_request events fire automatically against `main`.
```

If the name differs in your fork, run `gh workflow list` and use the **CI** workflow’s exact name or pass `-W .github/workflows/ci.yml`.

---

## How to interpret failed logs

1. Open **Actions** → failed workflow → failed **job**.
2. Expand the first **red** step; read from the **first error** upward (later steps are often cascades).
3. Download **Artifacts** when the job summary lists them (frontend logs, contract logs, audit JSON).
4. For **security comment** workflows, read the **issue comment** on the PR for a summary table, then cross-check the uploaded artifact for full detail.
5. For **Vercel**, open the deployment in the Vercel dashboard and read the **Build** log; search for `error` / `ELIFECYCLE`.

---

## What to include when asking maintainers for help

- **Link** to the failed GitHub Actions run (or Vercel deployment) and the **job name**.
- **Branch name** and whether the PR is from a **fork** (some checks skip or behave differently on forks).
- **Short excerpt** of the failing log (first stack trace or npm/cargo error block), not only “it failed.”
- **What you ran locally** and whether it passed or reproduced the same error.
- For **UI / Vercel**: screenshot or deployment URL, and confirmation of **Root Directory** + relevant `VITE_*` vars (no secrets—redact values if needed).
- If the failure is **intermittent**, note approximate time (UTC) and whether a re-run fixed it.

---

## Related links

- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [Contract security checklist](./contract-security-checklist.md)
- [Release checklist](./release-checklist.md)

---

## Stellar Wave: claiming issues and closing them

The **Stellar Wave** is StellarYield's open-source contributor program hosted on
[Drips](https://drips.network). Wave issues carry Drips points (complexity is set
by the maintainer in the Drips dashboard, not by a GitHub label). This section
explains the full lifecycle from claiming to merge.

### 1. Finding a Wave issue

Wave issues appear in the GitHub Issues tab. Look for the `stellar-wave` label or
browse the Drips maintainer dashboard for the project. Each issue lists an
**Expected Drips Points** value and a complexity tier (Low / Medium / High). The
points value shown in the issue body is set by the maintainer in the Drips
dashboard—do not attempt to change it by adding or removing GitHub labels, as that
can override the Drips configuration.

### 2. Claiming an issue

Before writing any code:

1. Verify the issue has the `status: available` label (or no active assignee).
2. Open the issue and post a comment using the
   [**Claim an Issue**](.github/ISSUE_TEMPLATE/claim_issue.yml) template.
   Fill in your GitHub handle, issue type (`Stellar Wave issue`), a brief
   planned approach, and an estimated completion date.
3. A maintainer will assign the issue to you (usually within 24 hours) and
   change the label to `status: in-progress`.
4. You do **not** need any special permissions to post a claim comment—any
   GitHub user can do it.

> **One active claim per contributor.** Do not claim a second issue while
> another is in progress. If you need to drop an issue, post a comment so a
> maintainer can release it.

### 3. Staying active: progress updates

Post a progress update **at least every 7 days** using the template in
[`.github/PROGRESS_UPDATE.md`](../.github/PROGRESS_UPDATE.md). Issues with no
update for 14+ days may be labelled `status: needs-update` and eventually
re-opened for others.

### 4. Branch and PR naming

Create a branch from the latest `main` of the **upstream** repository:

```bash
git fetch upstream
git checkout -b feat/issue-<number>-short-description upstream/main
```

Use a prefix that matches the type of work:

| Work type | Branch name |
|-----------|-------------|
| Feature | `feat/issue-611-correlation-id-middleware` |
| Bug fix | `fix/issue-612-apy-rounding` |
| Docs | `docs/issue-540-pr-naming-guide` |
| Refactor | `refactor/issue-618-vault-service` |

For PRs that address multiple related issues at once, list all numbers:

```
feat/issues-545-549-share-price-chart-and-manifest
```

Use conventional commit messages so reviewers can scan history quickly:

```text
feat: add APY comparison export
fix: handle missing vault metadata
docs: document contributor PR naming
refactor: simplify yield route scoring
```

PR titles should be short and include the issue number when it fits, for example
`docs: document contributor naming standards (#540)`.

### 5. Linking the issue in your PR

The PR body **must** include a closing keyword so GitHub (and Drips) can
automatically link and close the issue on merge. Use one of:

```
Closes #<issue-number>
Fixes #<issue-number>
Resolves #<issue-number>
```

If a single PR closes multiple issues, list each on its own line:

```
Closes #545
Closes #549
```

Place these lines in the **Description** section of the PR body, not only in
commit messages. GitHub only processes closing keywords in the PR body (or a
commit message on the default branch after merge) when the PR targets the same
repository's default branch.

### 6. PR description checklist

Use the [PR template](../.github/pull_request_template.md) and make sure to:

- Fill in every section (Description, Type of Change, Verification Commands).
- Reference the relevant [Issue Canvas](./issue-canvases.md) or template if the work originates from a scoped canvas.
- Check off `npm run lint` / `npm run test` (frontend/backend) or
  `cargo fmt` / `cargo clippy` / `cargo test` (contracts) as appropriate.
- Add UI snapshots (Desktop 1024px+ and Mobile 375px) if the PR touches
  React components or CSS; otherwise state **"No visual changes"** explicitly.
- Reference the issue number in the title (e.g. `feat: add correlation ID middleware (#611)`).

### 7. Review and merge expectations

- A maintainer will review your PR and may request changes. Address feedback
  promptly; PRs with no response to review comments for 7+ days may be closed.
- **Do not** force-push after a review has started—add new commits instead so
  the reviewer can see what changed.
- The maintainer merges via squash or merge commit (never rebase from a fork
  PR). You do not need to squash your commits yourself.
- Once the PR is merged to `main`, GitHub will automatically close the linked
  issue(s).

### 8. Drips points

Drips points are managed entirely through the **Drips maintainer dashboard**, not
by GitHub labels. Do **not** add or remove the `stellar-wave` label or change
issue complexity labels yourself—doing so can reset the points value to a Drips
default (typically 100 points) rather than the maintainer-set value. If you
believe the complexity of an issue is mis-classified, leave a comment on the
issue describing your reasoning and a maintainer will review it.

Points are distributed after the PR is merged and the issue is closed. You do not
need to do anything extra to receive them—Drips tracks the linked issue closure
automatically.
