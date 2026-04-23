# Contributing to StellarYield

Thanks for contributing to StellarYield. This repository contains frontend, backend, and Soroban contract code, so each pull request should stay focused and include the verification steps for the area it touches.

## Before You Open a PR

- Claim or reference the GitHub issue you are working on.
- Keep the change scoped to one feature, fix, or documentation update.
- Run the checks for each package you modified.
- Add or update tests when behavior changes.

## Local Verification

Use the quick commands in [README.md](./README.md), or follow the more detailed [Pre-commit Formatting and Verification Guide](./docs/contributor-guide.md).

## CI Failure Artifacts

If CI fails on your pull request, open the failed workflow run in GitHub Actions and check the **Artifacts** section. Frontend build logs, any generated frontend build output, and contract test logs are uploaded there for short-term debugging.

## Release Process

Maintainers should use the [Release Checklist](./docs/release-checklist.md) before and after merges that go to production.
