---
name: Contributor Task Canvas
about: Well-scoped canvas for contributor tasks, Stellar Wave bounties, and good first issues
title: '[Task Canvas]: '
labels: ['help wanted', 'canvas']
assignees: ''
---

# Task Canvas: [Task Title]

## Overview & Task Metadata

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Canvas Type** | `Contributor Task Canvas` | Self-contained task specification |
| **Issue #** | `Pending` | Associated tracking issue |
| **Maintainer / Mentor** | `@` | Point of contact for questions |
| **Points / Bounty** | `Points / Bounty` | Wave reward |
| **Difficulty Level** | `Beginner / Intermediate / Advanced` | Skill level |
| **Domain** | `Frontend / Backend / Contracts / Docs` | Stack area |
| **Estimated Time** | `X hours / X days` | Estimated completion time |

---

## Task Summary & Background Context

Provide a clear explanation of what needs to be done and why it is important for the project.

> [!NOTE]
> Review [CONTRIBUTING.md](../../CONTRIBUTING.md) and [docs/contributor-guide.md](../contributor-guide.md) before starting.

---

## Target Files & Code Locations

| File Path | Action | Description of Changes |
| :--- | :--- | :--- |
| `path/to/file` | `[MODIFY / NEW]` | Description of expected changes |

---

## Step-by-Step Implementation Guide

1. Create branch: `git checkout -b feat/issue-[number]-[slug]`
2. Implement required functionality.
3. Write unit tests to cover new code.
4. Run verification commands.

> [!TIP]
> Run `npm run setup:doctor` to verify your local toolchain before running tests.

---

## Local Verification Commands

- **Frontend**: `cd client && npm run lint && npm run test && npm run build`
- **Backend**: `cd server && npm run lint && npm test`
- **Contracts**: `cd contracts && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`

---

## Acceptance Criteria Checklist

- [ ] All requirements implemented according to specification.
- [ ] Unit tests pass with 100% success rate.
- [ ] Responsive UI snapshots provided if frontend was modified.
- [ ] PR description follows `.github/pull_request_template.md`.
- [ ] References issue number in PR description (`Fixes #[Issue Number]`).
