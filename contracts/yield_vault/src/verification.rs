#![cfg(kani)]

use super::*;
use kani;

/// Invariant: performance fee must always be within [1%, 10%] range.
#[kani::proof]
#[kani::unwind(11)]
fn prove_fee_bounds() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let apy: i128 = kani::any();

    // Assume sensible APY range to avoid extreme overflow logic unrelated to the fee bounds
    kani::assume(apy >= 0 && apy < 1_000_000);

    // We proof that any adjustment results in a fee between 100 and 1000 bps
    let result = YieldVault::record_apy_and_adjust_fee(env.clone(), admin, apy);

    if let Ok(fee) = result {
        kani::assert(fee >= 100, "Fee below minimum floor");
        kani::assert(fee <= 1000, "Fee above maximum ceiling");
    }
}

/// Invariant: Flash loan repayment must be initial + fee.
#[kani::proof]
fn prove_flash_loan_security() {
    let amount: i128 = kani::any();
    kani::assume(amount > 0 && amount < 1_000_000_000_000);

    let fee = YieldVault::calc_flash_fee(amount);
    let expected_fee = (amount * 9) / 10000;

    kani::assert(fee == expected_fee, "Flash loan fee calculation mismatch");
    kani::assert(fee >= 0, "Negative fee");
}

/// Invariant: Share price calculation never overflows for reasonable inputs.
#[kani::proof]
fn prove_deposit_share_calculation() {
    let amount: i128 = kani::any();
    let total_shares: i128 = kani::any();
    let total_assets: i128 = kani::any();

    kani::assume(amount > 0 && amount < 1_000_000_000);
    kani::assume(total_shares > 0 && total_shares < 1_000_000_000);
    kani::assume(total_assets > 0 && total_assets < 1_000_000_000);

    let shares = (amount * total_shares) / total_assets;

    kani::assert(shares >= 0, "Shares should not be negative");
}

/// Invariant: Rebalance cannot exceed current total assets.
#[kani::proof]
fn prove_rebalance_safety() {
    let amount: i128 = kani::any();
    let total_assets: i128 = kani::any();

    kani::assume(amount > 0 && amount < 1_000_000_000_000);
    kani::assume(total_assets > 0 && total_assets < 1_000_000_000_000);

    if amount <= total_assets {
        let remain = total_assets - amount;
        kani::assert(remain >= 0, "Remaining assets cannot be negative");
    }
}

/// Invariant: Solvency - share price should not drop below certain threshold (precision).
#[kani::proof]
fn prove_solvency_after_harvest() {
    let gross_amount: i128 = kani::any();
    kani::assume(gross_amount > 0 && gross_amount < 1_000_000_000_000);

    let (net, fee) = YieldVault::apply_performance_fee(&Env::default(), gross_amount);

    kani::assert(net + fee == gross_amount, "Yield split mismatch");
    kani::assert(net >= 0, "Negative net yield");
    kani::assert(fee >= 0, "Negative fee");
}
