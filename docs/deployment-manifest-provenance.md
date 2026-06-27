# Deployment Manifest Provenance

Deployment manifests are audit artifacts. In addition to the deployed contract IDs, every generated manifest contains a `provenance` object that records where the manifest came from and which source inputs were used to produce it.

## Provenance fields

| Field | Meaning | How maintainers should use it |
|---|---|---|
| `provenance.generatedBy` | The generator script that produced the manifest. | Confirms the manifest was emitted by the repository-supported generator rather than hand-authored. |
| `provenance.generatedAt` | UTC ISO-8601 timestamp for generation. | Must match top-level `generatedAt`; use it to order deployment artifacts. |
| `provenance.sourceInput.path` | Path to the `deployed.json` input used by the generator. | Identifies the direct source of contract IDs. Absolute paths usually indicate a temporary/local test fixture; repo-relative paths are expected for committed artifacts. |
| `provenance.sourceInput.sha256` | SHA-256 digest of the `deployed.json` bytes. | Recompute this hash from the source input to prove the contract IDs were generated from the expected file. |
| `provenance.registryInput.path` | Path to the registry file cross-referenced by the generator. | Shows which registry snapshot was used for best-effort drift warnings. |
| `provenance.registryInput.sha256` | SHA-256 digest of the registry snapshot, or `null` if no registry existed. | Recompute the hash to verify the registry snapshot that was available at generation time. |
| `provenance.network.name` | Target network (`testnet`, `mainnet`, or `local`). | Must match the top-level `network` and the network passed to `verify-manifest.js`. |
| `provenance.network.rpcUrl` | RPC endpoint recorded at generation time. | Confirms which RPC source was used. The value may be `unknown` for local/test fixtures where no endpoint was supplied. |
| `provenance.network.passphrase` | Stellar network passphrase recorded at generation time. | Distinguishes public, test, and local network contexts. This is not a secret. |
| `provenance.git.commitSha` | Git commit for the generator run. | Must match top-level `commitSha`; use it to inspect the exact code revision. |
| `provenance.git.branch` | Git branch for the generator run. | Must match top-level `branch`; useful for CI traceability. |
| `provenance.git.remoteUrl` | Git remote URL if available, otherwise `unknown`. | Confirms repository origin when manifests are produced outside GitHub Actions. |
| `provenance.ci.*` | CI provider/run/workflow/actor context, or local fallbacks. | Connects a manifest to the CI run or local operator that produced it. |

## Validation

Run the verifier after generating a manifest:

```bash
node contracts/scripts/verify-manifest.js \
  --manifest contracts/scripts/deployment-manifest.json \
  --registry contracts/registry.json \
  --network testnet
```

The verifier fails if provenance is missing or malformed before it compares contract IDs with `registry.json`. This ensures incomplete or hand-edited manifests cannot silently pass drift checks.

## Recommended review process

1. Confirm `provenance.network.name`, top-level `network`, and the verifier `--network` argument all agree.
2. Recompute `sha256` for the recorded source input and registry input when the files are available.
3. Use `provenance.git.commitSha` and `provenance.git.remoteUrl` to inspect the code that generated the manifest.
4. Use the CI fields to link the manifest back to its build/deployment run.
5. Treat `unknown` values as acceptable only for local fixtures or manually run dry-runs; production deployment artifacts should include the real RPC URL and network passphrase.
