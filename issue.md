#435 Fix API base URL fallback behavior in deployed preview environments
Repo Avatar
edehvictor/StellarYield
Summary
Preview deployments may default to localhost backend URLs unless VITE_API_BASE_URL is configured. Improve fallback behavior and docs so previews fail gracefully.

Acceptance Criteria
Audit current API base URL fallback logic.
Show a clear unavailable state when backend URL is not configured for preview.
Add tests for VITE_API_BASE_URL, VITE_API_URL, and fallback behavior.
Document required Vercel env vars for previews.
Technical Area
client/src/lib/api.ts, client/src/lib/api.test.ts

Points
200

Suggested Labels
Stellar Wave, bug, help wanted, points: 200


#448 Create maintainer dashboard issue triage view
Repo Avatar
edehvictor/StellarYield
Summary
Maintainers need a quick way to see claimed, unclaimed, blocked, and ready-for-review Wave issues.

Acceptance Criteria
Define issue labels or saved search queries for triage states.
Document a weekly triage workflow.
Optionally add a script that prints issue counts by label.
Ensure the process works with public contributor issues.
Technical Area
docs/triage-process.md, .github/, optional scripts/

Points
200

Suggested Labels
Stellar Wave, enhancement, help wanted, points: 200


#444 Add UI snapshot checklist for visual contribution reviews
Repo Avatar
edehvictor/StellarYield
Summary
Frontend PRs should include screenshots or short notes for changed views. Add a lightweight checklist for visual review expectations.

Acceptance Criteria
Document when screenshots are required.
List suggested viewport sizes for responsive checks.
Explain how to mention no visual changes.
Update PR template if appropriate.
Technical Area
CONTRIBUTING.md, docs/contributor-guide.md

Points
200

Suggested Labels
Stellar Wave, documentation, good first issue, points: 200

#443 Add release readiness checklist for Wave submissions
Repo Avatar
edehvictor/StellarYield
Summary
Wave submissions should have a clear checklist for build status, deployment, docs, tests, screenshots, and issue closure.

Acceptance Criteria
Create or update a Wave release checklist section.
Include CI, Vercel production, preview, smoke test, and docs checks.
Add guidance for linking PRs to issues.
Keep the checklist concise and actionable.
Technical Area
docs/release-checklist.md, README.md

Points
200

Suggested Labels
Stellar Wave, documentation, help wanted, points: 200


