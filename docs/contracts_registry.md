**Contracts Registry**

This document explains the `contracts/registry.json` file and the registry diff viewer.

- Location: `contracts/registry.json`
- Purpose: track Soroban contract IDs per environment (local, testnet, mainnet).
- Deployment: update this file after deployments; environment variables override at runtime.

Registry Diff Viewer
--------------------

We provide a simple viewer at `client/src/pages/transparency/RegistryDiff.tsx` which compares the current `contracts/registry.json` file against `contracts/registry.previous.json` (example snapshot). It highlights per-environment changes:

- Added: contract address present in new registry but missing in old.
- Removed: contract address removed in new registry.
- Changed: contract address changed between snapshots.
- Missing entries: any required contract names that are empty in the new registry — the UI shows a warning badge.

Usage
-----

To update the snapshot used for comparison, replace `contracts/registry.previous.json` with the previous deployment's registry (keep private addresses out of public commits). The viewer reads both files and renders a per-network diff.

Tests
-----

Unit tests for the diff logic are at `contracts/__tests__/registryDiff.test.ts` and cover added/removed/changed detection.
