use crate::storage::SCALAR_18;

pub const SECONDS_PER_YEAR: u64 = 31_536_000;

/// Calculate the new cumulative index based on the elapsed time and interest rate.
/// `index_last` - The previous cumulative index (scaled by 1e18).
/// `rate_per_year` - The APR (e.g., 0.05 * 1e18).
/// `elapsed` - Time in seconds since the last update.
pub fn calculate_index(index_last: i128, rate_per_year: i128, elapsed: u64) -> i128 {
    if elapsed == 0 {
        return index_last;
    }

    // Prevent overflow:  index_last ≈ 1e18, rate ≈ 0.05e18, elapsed ≤ 31.5M s
    // Naive: index * rate * elapsed  →  ~1e54  (overflows i128 max ~1.7e38)
    //
    // Safe order: compute elapsed_fraction = (rate_per_year * elapsed) / SECONDS_PER_YEAR first.
    // rate * elapsed ≤ 0.05e18 * 31.5M ≈ 1.575e24  (within i128)
    // Then: index_last * elapsed_fraction / SCALAR_18  ≤ 1e18 * ~5e16 / 1e18 ≈ 5e16 (safe)
    let elapsed_rate = (rate_per_year * elapsed as i128) / SECONDS_PER_YEAR as i128;
    let interest = (index_last * elapsed_rate) / SCALAR_18;

    index_last + interest
}

/// Calculate the debt amount in USD based on debt shares and cumulative index.
/// `debt_shares` - The user's shares of the total debt.
/// `index` - The current cumulative index (scaled by 1e18).
pub fn calculate_debt(debt_shares: i128, index: i128) -> i128 {
    (debt_shares * index) / SCALAR_18
}

/// Calculate the value of collateral in USD.
/// `collateral` - Number of vault shares.
/// `vault_assets` - Total assets in the vault.
/// `vault_shares` - Total shares of the vault.
/// `price_usd` - Price of the underlying asset in USD (scaled by 1e7).
pub fn calculate_collateral_value(
    collateral: i128,
    vault_assets: i128,
    vault_shares: i128,
    price_usd: i128,
) -> i128 {
    if vault_shares == 0 {
        return 0;
    }
    
    // value = collateral * (assets / shares) * price
    // (collateral * assets * price) / (shares * 1e7)
    (collateral * vault_assets * price_usd) / (vault_shares * 10_000_000)
}

/// Calculate the Collateralization Ratio in basis points (10000 = 100%).
pub fn calculate_cr(collateral_value: i128, debt_value: i128) -> u32 {
    if debt_value == 0 {
        return u32::MAX;
    }
    
    ((collateral_value * 10000) / debt_value) as u32
}
