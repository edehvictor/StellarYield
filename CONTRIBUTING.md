## Contributing to StellarYield

Thanks for contributing to StellarYield, a Stellar-native DeFi yield aggregator and automated vault system. We rely on the community to help build secure, efficient, and accessible DeFi tools.

### Before You Start 

* **Read the Docs:** Review the `README.md` for overall architecture context.
* **Claim an Issue:** Browse the active issues, especially those tagged for the Stellar Wave, before starting work. Please ask to be assigned before opening a PR.
* **Use Issue Canvases:** For non-trivial features, refactors, or smart contract tasks, review and follow the [Issue Canvases Framework](./docs/issue-canvases.md) and use the markdown templates in [`docs/templates/issue-canvases/`](./docs/templates/issue-canvases/README.md).
* **Keep it Focused:** Keep pull requests limited to one specific feature, bug fix, or contract concern at a time.
* **Discuss Major Changes:** Start a discussion in the issues tab before changing core architecture, smart contract storage models, or automated routing logic.

### 🙋 How to Claim an Issue

1. Find an open issue labelled `status: available` or `good-first-issue`.
2. Post a comment using the **Claim an Issue** template (`.github/ISSUE_TEMPLATE/claim_issue.yml`) — no maintainer action needed to post.
3. A maintainer will assign the issue to you, usually within 24 hours.
4. Post a progress update at least every **7 days** using the template in `.github/PROGRESS_UPDATE.md`.
5. If you need to drop the issue, post a comment so it can be re-claimed by someone else.

**Label lifecycle:**

| Label | Meaning |
|-------|---------|
| `status: available` | Unclaimed — anyone can pick it up |
| `status: claimed` | A contributor has posted a claim; awaiting assignment |
| `status: in-progress` | Assigned and actively being worked on |
| `status: needs-update` | No update for 7+ days — contributor should check in |

Issues with `status: needs-update` for more than 14 days may be re-opened for others.

### 🌿 Branch, Commit, and PR Naming

Use short, descriptive names that include the issue number when possible.

**Branches**

| Work type | Branch example |
|-----------|----------------|
| Feature | `feat/issue-540-contributor-naming` |
| Bug fix | `fix/issue-612-apy-rounding` |
| Docs | `docs/issue-540-pr-naming-guide` |
| Refactor | `refactor/issue-618-vault-service` |

**Commits**

Follow the conventional commit style:

```text
feat: add APY comparison export
fix: handle missing vault metadata
docs: document contributor PR naming
refactor: simplify yield route scoring
```

**Pull requests**

- Include the issue number in the title when it fits, for example `docs: document contributor naming standards (#540)`.
- Add `Closes #<issue-number>`, `Fixes #<issue-number>`, or `Resolves #<issue-number>` in the PR body so GitHub links and closes the issue on merge.
- Keep one PR focused on one issue unless a maintainer asks you to combine related work.

### 💻 Local Setup
Since StellarYield is a full-stack monorepo, ensure you have the correct environments set up for the stack you are touching:

* **Smart Contracts:** Install the stable Rust toolchain and the `soroban-cli`. Make sure `rustfmt` and `clippy` are available.
* **Frontend/Backend:** Ensure Node.js 20+ is installed, matching CI.

### Verification Commands

Before submitting a pull request, run the checks that match what you changed. **GitHub Actions treats some steps as advisory**; you should still fix lint and build issues before review. For a full matrix of blocking vs advisory checks, copy-paste commands that mirror CI, and how to read failure logs, see [docs/contributor-guide.md](./docs/contributor-guide.md).

**For Soroban contracts (`contracts/`):**

```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

**For the frontend (`client/`):**

```bash
cd client
npm run lint
npm run test
npm run build
```

**For the backend (`server/`)** you need PostgreSQL and `DATABASE_URL`:

```bash
cd server
npm run lint
npm run build
npm test
```

### 🖼️ UI Snapshot Checklist for Visual Reviews
If your PR modifies the frontend or introduces new UI components, you **must** provide UI snapshots (screenshots or short screen recordings).

#### When screenshots are required:
- ✅ Any change to CSS, layout structure, or styling
- ✅ New React components or modifications to existing components
- ✅ Changes to responsive breakpoints or media queries
- ✅ Color, font, sizing, or spacing changes
- ✅ New forms, modals, dialogs, or interactive elements
- ❌ Pure logic refactoring with no UI impact (if applicable, mark "No visual changes")
- ❌ Changes to non-visual backend API calls or utilities

#### Screenshot viewport requirements:
Provide screenshots for these viewport sizes to validate responsive design:

| Viewport | Size | Device | Notes |
| --- | --- | --- | --- |
| Desktop | 1024px+ width | Laptop/Desktop | Full layout, all features visible |
| Tablet | 768px width | iPad/Tablet | Medium breakpoint, navigation changes |
| Mobile | 375px width | iPhone SE/Mobile | Smallest breakpoint, stacked layout |

**Quick capture tools:**
- **Browser DevTools:** F12 → Toggle device toolbar → Change viewport width
- **Screenshot:** On Mac: `Cmd + Shift + 4`. On Windows: `Win + Shift + S`. On Linux: `gnome-screenshot`.
- **Video:** For complex interactions (scroll, hover, transitions), use a screen recorder (Loom, CleanMyMac's video recording, OBS) and upload as a Gist video link.

#### How to include UI snapshots in your PR:
1. **In the PR description**, under **Screenshots (if applicable):**
   ```markdown
   ![Desktop view at 1024px](url-to-screenshot)
   ![Mobile view at 375px](url-to-screenshot)
   ```
2. **Or upload directly to GitHub PR:** Drag-and-drop images or use the attachment UI when editing the PR description.
3. **Mark the checklist:** In the PR template, check the boxes for which viewports you've tested.

#### If there are no visual changes:
If your PR touches the `/client` directory but does **not** change the UI (e.g., refactoring logic, updating API calls, fixing accessibility without visual changes), explicitly mention:
```markdown
## UI Snapshot Checklist
- [x] No visual changes

This PR refactors API call logic in the dashboard without changing the visual appearance.
```

#### Reviewer expectations:
- Reviewers will **check for visual regressions**, broken layouts, and responsive behavior.
- Reviewers may ask for additional viewport sizes if mobile or tablet appearance is unclear.
- During review, click the **Vercel Preview** link (usually in the PR checks) to interact with the live version.

#### Accessibility & contrast:
When including UI screenshots, ensure:
- Text is legible (good contrast against background).
- Focus states are visible (keyboard navigation).
- Color is not the only way to convey information (use icons, labels, patterns too).

For detailed accessibility guidance, see [docs/contributor-guide.md](./docs/contributor-guide.md).

### Core Contribution Rules

1. **Security First:** Treat vault deposits, withdrawals, fee structures, and rebalancing logic as high-sensitivity areas.
2. **Document State Changes:** Document any smart contract storage or event changes clearly using NatSpec-style comments.
3. **Test Everything:** Add or update unit tests for every behavior change. Minimum 90% coverage is expected for financial logic.
4. **Contextual Naming:** Keep variable names and comments specific to StellarYield and Soroban, avoiding generic template wording.

### Good First Issue Guidance

If you are adding a "Good First Issue" to the backlog, it should:

* Avoid protocol-level economic or security changes.
* Have a narrow scope, such as a single UI component or a read-only view function.
* Include explicit acceptance criteria.
* Be easily testable in isolation.

### Questions and Scope

If a change requires touching the client UX, the backend API, and the smart contracts, please split that work into separate, sequential pull requests to make reviewing easier and safer.

### CI or Vercel Failures

Include a link to the failed workflow run or Vercel deployment log, your branch name, whether the PR is from a fork, the first concrete error from the logs, what you already ran locally, and screenshots or the preview URL for UI changes. See "What to include when asking maintainers for help" in [docs/contributor-guide.md](./docs/contributor-guide.md).

### Running Workflows Locally

Use the command blocks in [docs/contributor-guide.md](./docs/contributor-guide.md) for parity with `.github/workflows/ci.yml` and related workflows. Optional: [nektos/act](https://github.com/nektos/act) with Docker. You can also trigger a run on GitHub with `gh workflow run CI --ref "$(git branch --show-current)"`.

## 🎯 Release Readiness (Wave Submissions)

Before requesting a review on a **Stellar Wave** PR, please review the **[Release Readiness Checklist](./docs/release-checklist.md#stellar-wave-submission-checklist)** to ensure all items are checked:

- ✅ Issue linking (`Fixes #ISSUE_NUMBER`)
- ✅ CI checks pass (GitHub Actions, Vercel Preview)
- ✅ Code quality (lint, test, coverage)
- ✅ Visual design (screenshots for Desktop & Mobile if UI changed)
- ✅ Documentation (comments, NatSpec, README updates)
- ✅ Smoke test (manual verification in Vercel Preview)
- ✅ Security (no hardcoded secrets; auth checks in place)
- ✅ PR template completed (all checkboxes checked)

See [docs/release-checklist.md](./docs/release-checklist.md) for the full checklist and guidance on deployment (for maintainers).

## Yield Normalization

Any change that produces, aggregates, or displays a yield figure must follow the
[yield normalization contract](./server/docs/yield-normalization-contract.md):
APY in percent at two decimals, USD in dollars at two decimals, rounded half
away from zero, exactly once, at the point the value is emitted.

Import the helpers from `server/src/utils/yieldNormalizationContract.ts` rather
than writing a local `round2` or dividing by `100` inline — a local copy is how
feed ingestion and portfolio summaries drift apart. `npm test --prefix server -- yieldNormalization`
runs the parity checks, and `GET /api/yields/parity` reports the same
diagnostics against a running server.

## Contract Security

Pull requests that touch `contracts/` must pass the checklist in [docs/contract-security-checklist.md](./docs/contract-security-checklist.md) before review. The checklist covers storage schema changes, authorization checks, arithmetic safety, test coverage, and admin permission review.

## CI Failure Artifacts, Logs, and Fuzzing

Failed workflow runs may publish downloadable artifacts such as frontend test/build logs or contract test output. Open the run in the Actions tab and scroll to Artifacts, or follow [How to interpret failed logs](./docs/contributor-guide.md#how-to-interpret-failed-logs) in the contributor guide.

### Running the Fuzzing Suite

The vault includes a property-based testing suite built with `proptest`. To run the fuzz tests:

```bash
cd contracts
cargo test --test fuzz_tests -- --nocapture
```

To run with more iterations before merging security-sensitive changes:

```bash
PROPTEST_CASES=100000 cargo test --test fuzz_tests -- --nocapture
```

The fuzzing suite validates these invariants:

* `total_shares` and `total_assets` are never negative.
* First depositor receives 1:1 shares.
* Full withdrawal returns the exact deposited amount for a sole depositor.
* Multi-user deposits produce proportional shares.
* Share price never decreases from deposit/withdraw operations.
* Rebalance correctly updates tracked assets.
