#!/usr/bin/env bash
set -euo pipefail

# Keep the release gate focused on contracts whose public entrypoints are
# exercised by the upgrade compatibility matrix.
cargo test --manifest-path contracts/Cargo.toml -p yield_vault
cargo test --manifest-path contracts/Cargo.toml -p optimistic_governance
cargo test --manifest-path contracts/Cargo.toml -p emission_controller
