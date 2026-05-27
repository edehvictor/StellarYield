## Summary
This PR implements fixes and documentation enhancements across four primary areas for the StellarYield platform:
1. **API Fallback Behavior**: Implemented robust API base URL fallback logic to ensure Vercel preview environments fail gracefully when no backend URL is configured, avoiding incorrect default requests to localhost.
2. **Issue Triage View**: Added a new maintainer workflow and search query documentation for triaging Stellar Wave issues, including a foundational `issue-triage.js` script.
3. **UI Snapshot Checklist**: Updated the `.github/pull_request_template.md` and `CONTRIBUTING.md` to require UI snapshots (Desktop and Mobile) for any frontend visual changes.
4. **Release Readiness**: Added a comprehensive `release-checklist.md` to ensure all Wave submissions meet CI, testing, and deployment standards before review.

## Linked Issue
Closes #435
Closes #448
Closes #444
Closes #443

## Change Type
- [x] Bug fix (non-breaking change which fixes an issue)
- [x] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [x] Documentation update
- [ ] Refactor
- [ ] Other (please describe):

## Testing
- Added unit tests for `getApiBaseUrl` inside `client/src/lib/api.test.ts` to ensure that environment variables properly override the localhost fallback, and that preview environments without configurations safely throw an error.
- Ran tests successfully to ensure no regressions with upstream API base URL configurations.

### Checklist
- [x] Frontend changes tested
- [ ] Backend changes tested
- [ ] Contracts changes tested
- [x] Documentation updated
- [ ] Migrations tested (if applicable)

## Screenshots (if applicable)
No visual UI changes were made in this PR (only API configuration logic and documentation updates).

## Deployment Notes
For preview deployments on Vercel, ensure that either `VITE_API_BASE_URL` or `VITE_API_URL` is set in the environment variables. If they are missing, the frontend application will explicitly throw an `API_UNAVAILABLE` error to prevent silent failures and timeout requests to localhost.
