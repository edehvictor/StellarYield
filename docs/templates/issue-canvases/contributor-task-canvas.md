# Task Canvas: [Task Title]

> **Template Instructions**: Use this canvas when scoping self-contained contributor tasks, Stellar Wave bounties, or good-first-issues. The goal is to provide contributors with complete, unambiguous context, file locations, verification commands, and acceptance criteria.

---

## Overview & Task Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Contributor Task Canvas` | Self-contained task specification |
| **Issue #** | `#[Issue Number]` | Associated GitHub issue |
| **Maintainer / Mentor** | `@[Maintainer Handle]` | Point of contact for questions |
| **Points / Bounty** | `[e.g. 100 points / $150 USDC / Good First Issue]` | Reward / Wave Points |
| **Difficulty Level** | `Beginner` / `Intermediate` / `Advanced` | Estimated skill requirement |
| **Domain** | `Frontend / Backend / Contracts / Docs / DevOps` | Target technology stack |
| **Estimated Time** | `[e.g. 2 - 4 hours / 1 - 2 days]` | Estimated completion timeframe |

---

## Task Summary & Background Context

### Summary
Provide a concise overview of what needs to be accomplished and why it matters for StellarYield.

### Background Context
Explain how this task fits into the larger application architecture.

> [!NOTE]
> Review [CONTRIBUTING.md](../../CONTRIBUTING.md) and [docs/contributor-guide.md](../contributor-guide.md) before starting.

---

## Target Files & Code Locations

| File Path | Action | Description of Expected Changes |
| :--- | :--- | :--- |
| `[e.g. client/src/components/VaultCard.tsx]` | `[MODIFY]` | Add APY breakdown tooltip and hover states |
| `[e.g. client/src/components/ApyTooltip.tsx]` | `[NEW]` | Create reusable tooltip component |
| `[e.g. client/src/__tests__/ApyTooltip.test.tsx]` | `[NEW]` | Unit tests for calculation and rendering |

---

## Detailed Requirements & Constraints

1. **Requirement 1**: Detailed explanation of feature behavior or UI layout.
2. **Requirement 2**: State handling, props, or API parameters.
3. **Requirement 3**: Accessibility, responsive design, or error state handling.

> [!IMPORTANT]
> **Boundary Constraints**:
> - Do not modify unrelated components or database models outside the specified scope.
> - Ensure all new dependencies are approved by maintainers before adding to `package.json` or `Cargo.toml`.

---

## Step-by-Step Implementation Guide

1. **Step 1: Setup Branch**
   ```bash
   git checkout -b feat/issue-[number]-[short-slug]
   ```
2. **Step 2: Implement Component / Logic**
   Follow the target file specifications above.
3. **Step 3: Add Unit Tests**
   Ensure tests cover normal usage, edge cases, and empty/error states.
4. **Step 4: Verify Formatting and Quality**
   Run the local verification commands listed below.

> [!TIP]
> Use `npm run setup:doctor` to confirm your local development environment is configured properly before running tests.

---

## Local Verification Commands

Run the commands corresponding to the workspaces modified in your task:

### Frontend Verification
```bash
cd client
npm run lint
npm run test
npm run build
```

### Backend Verification
```bash
cd server
npm run lint
npm test
```

### Smart Contract Verification
```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

---

## UI Snapshot Requirements (Frontend Only)

If your changes alter the visual presentation of the frontend, attach screenshots for:
- [ ] Desktop Viewport (1024px+)
- [ ] Tablet Viewport (768px)
- [ ] Mobile Viewport (375px)

---

## Acceptance Criteria Checklist

- [ ] All requirements listed in the detailed specification are implemented.
- [ ] New unit tests written and passing with 100% success rate.
- [ ] No linting or TypeScript compilation errors.
- [ ] PR description follows `.github/pull_request_template.md`.
- [ ] Linked issue referenced in PR body (`Fixes #[Issue Number]`).

---

## PR Submission & Review Guide

1. Push your branch to GitHub.
2. Open a Pull Request referencing this issue number.
3. Fill out all sections in the PR template.
4. Tag `@maintainer` if you need clarification or assistance.
