# Maintainer Issue Triage Process

This document outlines the weekly issue triage workflow for StellarYield maintainers, especially during the Stellar Wave program. It provides a repeatable workflow for claimed, unclaimed, blocked, and ready-for-review work without requiring private repository permissions.

## Triage States

- `unclaimed`: No contributor owns the issue. This is the default incoming state for public Wave issues.
- `claimed`: A contributor or maintainer has taken ownership and is actively working the issue.
- `blocked`: Work cannot proceed until an external dependency, maintainer answer, or deployment detail is available.
- `review-needed`: A pull request exists and needs maintainer review, CI verification, or deployment validation.

## Saved Search Queries

Use the following saved searches and dashboard commands to keep tracking work visible:

- `scripts/maintainer_saved_searches.sh` — example saved searches for quick triage (run locally and paste the output into a triage ticket).
- `scripts/issue-triage.js` — automated dashboard showing current triage state counts (see below).

### Maintainer Triage Dashboard

Run this command to get a quick overview of triage-relevant issues:

```bash
GITHUB_TOKEN=ghp_xxx node scripts/issue-triage.js
```

**Output example:**
```text
📊 StellarYield Maintainer Triage Dashboard
==================================================

🆓 Unclaimed Wave Issues:      12
✅ Claimed Wave Issues:        5
👀 Wave PRs (all states):      3
⛔ Blocked Issues:             2
❓ Needs Info:                 1
📈 Total Open Issues:          28
```

### GitHub Token Setup

1. Visit https://github.com/settings/tokens/new
2. Create a **Personal Access Token (Classic)** with the `repo` and `public_repo` scopes.
3. Copy the token and save it securely:
   ```bash
   export GITHUB_TOKEN=ghp_xxx
   ```
4. Run the dashboard script:
   ```bash
   node scripts/issue-triage.js
   ```

### Recommended Queries

| State | Query | Action |
| --- | --- | --- |
| Unclaimed issues | `is:issue is:open label:"Stellar Wave" label:"help wanted" no:assignee` | Check clarity, add `good-first-issue` when appropriate, and invite contributors to claim. |
| Claimed issues | `is:issue is:open label:"Stellar Wave" assignee:*` | Check for stale claims and ask for an update after seven inactive days. |
| Ready for review | `is:pr is:open label:"Stellar Wave" review:required` | Assign or request a maintainer review. |
| Blocked issues | `is:issue is:open label:"blocked"` | Follow up on the missing input and remove the label once unblocked. |

**Escalation & Handoff**
- If something is `blocked` for more than 24 hours, ping the on-call channel with a short context message and link.
- For `review-needed`, if no reviewer is assigned within 24 hours, post a short summary and tag the rotation-maintainers group.

**Notes**
- This process is intentionally permission-agnostic. Use labels and issue body markers rather than requiring new team membership.

### Creating Saved Searches

1. Go to https://github.com/edehvictor/StellarYield/issues
2. Paste one of the query strings above into the search box
3. Click the **Save** button (or bookmark the URL)
4. Refer to your saved searches during triage

## Weekly Triage Workflow

Every Monday (or on your chosen triage day), maintainers should follow this process:

1. Review new issues created in the past week and apply accurate labels such as `Stellar Wave`, `bug`, `enhancement`, or `points: 200`.
2. Run the saved searches above or `node scripts/issue-triage.js` from the repository root.
3. Re-open unclear issues with a short question and the `needs info` label.
4. Check stale claimed issues. If there has been no response for more than seven days, ask for an update before unassigning.
5. Review blocked issues and add a concrete next step, owner, and expected follow-up date.
6. Move PR-backed work into review by confirming linked issues, CI status, preview deployment status, and screenshots when UI changed.

### Suggested Cadence

- Run the dashboard first to capture the current counts for unclaimed, claimed, blocked, and needs-info issues.
- Review each new issue for clear acceptance criteria and assign labels where needed.
- Ping assignees or contributors if a claimed issue has gone stale for more than seven days.
- Keep the triage thread visible by documenting blockers and next actions.

## Public Contributor Workflow

Public contributors may not be assignable until they comment or join the repository workflow. If GitHub assignment is unavailable, add a comment such as:

```text
@username has claimed this issue.
```

Keep the claim visible in the issue thread, and ask contributors to link their PR with `Fixes #ISSUE_NUMBER` so review and closure stay connected.

## Escalation and Handoff

- If an issue is blocked for more than 24 hours, post a short context update and link the issue in the maintainer channel.
- If a PR is ready for review for more than 24 hours, tag the reviewer rotation with the PR link and the first needed action.
- If a contributor needs to hand off a claimed issue, ask them to leave their branch, test notes, and remaining task list in the issue.

## Issue Canvas Selection & Scoping

When triaging or scoping complex issues, maintainers should convert or enhance raw issue tickets with the corresponding **Issue Canvas** (`docs/issue-canvases.md`):

| Issue Classification | Recommended Issue Canvas | Template Link |
| :--- | :--- | :--- |
| **New Feature / Epic** | Feature & Epic Canvas | [`docs/templates/issue-canvases/feature-canvas.md`](./templates/issue-canvases/feature-canvas.md) |
| **Complex Defect / RCA** | Bug Investigation Canvas | [`docs/templates/issue-canvases/bug-investigation-canvas.md`](./templates/issue-canvases/bug-investigation-canvas.md) |
| **Soroban Smart Contract** | Smart Contract Canvas | [`docs/templates/issue-canvases/contract-invariant-canvas.md`](./templates/issue-canvases/contract-invariant-canvas.md) |
| **Refactor / Schema Migration** | Architecture & Refactor Canvas | [`docs/templates/issue-canvases/architecture-refactor-canvas.md`](./templates/issue-canvases/architecture-refactor-canvas.md) |
| **Security / Exploit Fix** | Security Remediation Canvas | [`docs/templates/issue-canvases/security-remediation-canvas.md`](./templates/issue-canvases/security-remediation-canvas.md) |
| **Stellar Wave Task / Bounty** | Contributor Task Canvas | [`docs/templates/issue-canvases/contributor-task-canvas.md`](./templates/issue-canvases/contributor-task-canvas.md) |

> [!TIP]
> Using standard canvases ensures contributors have clear acceptance criteria, explicit invariant definitions, and exact verification commands before commencing work.

## Tools & Links

- **Issue Canvases Guide:** [docs/issue-canvases.md](./issue-canvases.md)
- **Canvas Templates:** [docs/templates/issue-canvases/](./templates/issue-canvases/README.md)
- **Triage Dashboard:** `node scripts/issue-triage.js`
- **Saved Searches:** https://github.com/edehvictor/StellarYield/issues
- **GitHub Tokens:** https://github.com/settings/tokens
- **Stellar Wave Program:** See root `README.md` for Wave details
