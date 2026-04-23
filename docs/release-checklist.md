# Release Checklist

Use this checklist for merges to `main` that are expected to deploy to production.

## Before Merge

- Confirm the pull request is linked to its issue and all required checks are green.
- Confirm the `CI` workflow passed, including frontend, backend, contracts, and README verification jobs.
- Review any uploaded GitHub Actions artifacts if a rerun was needed during validation.
- Verify required Vercel environment variables are present for the target environment.
- Verify backend environment variables and contract deployment configuration are current.
- Confirm any contract changes include deployment or migration notes.

## Protected Branch Approval

Protected branch merges should be approved by repository maintainers who have the GitHub permissions required by the `main` branch protection rules. Contributors without those permissions should not self-merge.

## Deployment Checks

- Confirm the Vercel deployment for `main` finishes successfully.
- Confirm any backend deployment job or hosting platform reports a healthy release.
- Confirm Soroban contract deployment steps, addresses, and network targets match the intended release.
- Record any updated contract addresses or environment values in the relevant docs or deployment notes.

## Post-deploy Smoke Checks

### Frontend

- Load the production site and verify the homepage renders without console-breaking errors.
- Confirm wallet connection UI still appears and basic navigation works.
- Verify at least one API-backed view loads expected data.

### Backend

- Check the deployed API health endpoint or primary route.
- Confirm logs do not show startup failures, missing environment variables, or connection errors.
- Validate at least one client-facing API request succeeds against the deployed environment.

## Rollback Notes

- If the frontend deployment is unhealthy, redeploy the last known good Vercel build.
- If the backend release is unhealthy, roll back to the previous stable deployment in the hosting platform.
- If a contract deployment is incorrect, stop frontend promotion of the new addresses and follow the contract-specific remediation plan before resuming traffic.

## Documentation

- Keep this checklist linked from `README.md` and `CONTRIBUTING.md`.
- Update the checklist when deployment tooling, approval policy, or smoke-test expectations change.
