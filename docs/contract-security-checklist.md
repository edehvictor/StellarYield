# Contract Security Checklist

This checklist applies to every pull request that modifies files under `contracts/`. It is designed to be concise enough to paste into a PR description or use as a quick self-review before requesting a code review.

Run the full test suite from `contracts/` before marking any item as done:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

---

## 1. Storage Changes

- [ ] Every new storage key is documented in a comment or in `docs/contracts/storage-ttl-strategy.md`.
- [ ] Removed or renamed keys have a migration path (bump version, provide a migration entry point, or confirm the data can be safely abandoned).
- [ ] TTL extensions are explicitly set for any new `persistent` or `temporary` entries; no entry relies on the default TTL alone.
- [ ] If the storage schema is shared across upgrade boundaries, a version field is present so future migrations can detect the old layout.

## 2. Authorization Checks

- [ ] Every public entry point calls `env.current_contract_address().require_auth()` or the appropriate `require_auth_for_address` before touching state.
- [ ] Admin-only functions verify the caller against the stored admin address; they do not rely on the deployer key implicitly.
- [ ] Functions that accept an `invoker` or `from` address parameter validate that the signer matches before crediting or debiting balances.
- [ ] No authorization check is skipped in test-only `#[cfg(test)]` paths that could be accidentally shipped.

## 3. Arithmetic Safety

- [ ] All arithmetic on user-supplied amounts uses checked operations (`checked_add`, `checked_sub`, `checked_mul`, `checked_div`) or equivalent.
- [ ] Intermediate values are widened to `i128` or `u128` before multiplication to prevent intermediate overflow.
- [ ] Division-by-zero is explicitly guarded; never divide by a caller-supplied value without a non-zero assertion.
- [ ] Fee calculations are verified to remain within the declared bounds (`set_fee_bounds`) before they are applied.

## 4. Test Coverage

- [ ] Every new public entry point has at least one happy-path unit test.
- [ ] Negative tests cover: unauthorized callers, zero amounts, values at or beyond declared limits.
- [ ] If a test relies on mock time or ledger state, the mock values are realistic (not `u64::MAX` or similar) so the test catches actual runtime edge cases.
- [ ] `cargo test --workspace` passes clean with no ignored test output lines that conceal failures.

## 5. Admin Permission Review

- [ ] No new admin role or privileged key is introduced without a corresponding governance proposal documenting the rationale.
- [ ] If a new admin capability is added, it is gated behind the existing multi-sig governance flow described in [docs/governance-proposal-lifecycle.md](./governance-proposal-lifecycle.md).
- [ ] `set_admin` and similar key-rotation functions are tested for the case where the new admin is the zero address or an invalid key.
- [ ] The PR description names every address or role that gains elevated access as a result of this change.

---

## Quick Reference: Test Commands

```bash
# From contracts/
cargo test --workspace                          # all unit + integration tests
cargo test --workspace -- --nocapture           # with stdout for debugging
cargo test -p <crate-name> <test_name>          # single test
cargo clippy --workspace --all-targets -- -D warnings  # lint
```

For storage layout details see [`docs/contracts/storage-ttl-strategy.md`](./contracts/storage-ttl-strategy.md).
