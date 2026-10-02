# Contract upgrade smoke tests

The upgrade gate runs the contract test suites that exercise the public
entrypoints used by the vault, rewards/emission, and governance deployments.
Run it from the repository root before publishing a new WASM:

```bash
./contracts/upgrade-smoke.sh
```

The script intentionally runs the workspace packages separately so a failure
identifies the affected contract and does not get hidden by an unrelated
server test.

| Contract surface | Success paths | Expected failure paths | Test location |
| --- | --- | --- | --- |
| Yield vault | initialize, deposit, withdraw, referral rewards, keeper and emergency operations | double initialization, zero amounts, insufficient shares, unauthorized admin operations | `contracts/yield_vault/src/lib.rs` and module tests |
| Rewards/emission | initialize parameters, bounded emission calculation, PID convergence | invalid bounds, invalid utilization, unauthorized configuration | `contracts/emission_controller/src/lib.rs` |
| Governance | initialize, propose, challenge-window expiry, execute | early execution, disputes, missing voting power, double execution | `contracts/optimistic_governance/src/test.rs` |

These are entrypoint-level compatibility tests: they run against the current
contract WASM build and preserve the expected callable interface and failure
semantics across releases. If an upgrade changes an entrypoint signature or
error behavior, the focused package command fails before release.
