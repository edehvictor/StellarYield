//! # Yield Vault Fuzzing & Invariant Testing Suite
//!
//! Property-based tests using `proptest` to verify that the vault's core
//! mathematical invariants hold across millions of randomized inputs.
//!
//! ## Invariants tested
//! 1. `total_shares >= 0` at all times.
//! 2. `total_assets >= 0` at all times.
//! 3. First deposit mints 1:1 shares.
//! 4. Deposit then full withdrawal returns exact original amount (sole depositor).
//! 5. Multi-user deposits produce proportional shares.
//! 6. Rebalance correctly updates assets.
//! 7. Share price never decreases from deposit/withdraw.
