# Maintainer Issue Triage Process
**Triage Process**

- **Purpose:** Provide a repeatable daily workflow for maintainers to triage issues, signals, and operational alerts without changing GitHub permissions.

**Triage States**
- `unassigned`: No maintainer owns the issue; default incoming state.
- `claimed`: A maintainer has taken ownership and is working the issue.
- `blocked`: Work cannot proceed until an external dependency or data is available.
- `review-needed`: Work complete, needs another maintainer to approve or verify.

**Daily Maintainer Workflow (repeatable)**
1. Morning scan (10–20 minutes): run saved searches (examples below) to collect new `unassigned` items.
2. Claim items you can resolve quickly. Mark as `claimed` in the issue body or labels.
3. For items needing input (from ops, infra, nodes, or third parties), mark `blocked` and add a clear next-step.
4. For code or strategy changes finish work and mark `review-needed` with a short checklist.
5. End-of-day: update any long-running `claimed` items with progress notes and estimate next steps.

**Saved-search examples / lightweight reporting**
We keep some simple shell helpers in `scripts/` to produce lists you can paste into Slack or create issues from.

- `scripts/maintainer_saved_searches.sh` — example saved searches for quick triage (example usage: run locally and paste results into a triage ticket).

**Escalation & Handoff**
- If something is `blocked` for >24h, ping the on-call channel with a short context message and link.
- For `review-needed`, if no reviewer in 24h, post a short summary and tag the rotation-maintainers group.

**Notes**
- This process is intentionally permission-agnostic. Use labels and issue body markers rather than requiring new team membership.
# Issue and PR Triage Process

This document outlines the weekly issue triage workflow for the StellarYield maintainers, particularly for the Stellar Wave program.

## Saved Search Queries / Triage States

To maintain visibility over community contributions, use the following GitHub search queries:

1. **Unclaimed Issues (Ready for Community)**
   `is:issue is:open label:"Stellar Wave" label:"help wanted" no:assignee`
   *Action:* Review for clarity, add 'good first issue' if applicable.

2. **Claimed Issues (In Progress)**
   `is:issue is:open label:"Stellar Wave" has:assignee no:linked-pr`
   *Action:* Ping assignees if there has been no activity for >7 days.

3. **Ready for Review (PR Submitted)**
   `is:pr is:open label:"Stellar Wave" review:required`
   *Action:* Assign a maintainer to review.

4. **Blocked / Needs Input**
   `is:issue is:open label:"blocked" OR label:"needs info"`
   *Action:* Follow up on requested information.

## Weekly Triage Workflow

Every Monday, maintainers should follow this process:

1. **Review New Issues**: Scan all new issues created in the past week. Apply appropriate labels (`Stellar Wave`, `bug`, `enhancement`, `points: xxx`).
2. **Check Stale Claims**: Unassign contributors who have not responded for over a week to free up issues for others.
3. **Unblock Contributors**: Answer questions on issues labeled `needs info` or `blocked`.
4. **Run Issue Triage Script**: Run the `scripts/issue-triage.js` to get an overview of the issue counts.

## Public Contributor Considerations
Ensure that labels are clear, and that any "claimed" state is visibly marked by assigning the user. If the user cannot be assigned due to GitHub permissions, add a comment explicitly stating: `@username has claimed this issue.`
