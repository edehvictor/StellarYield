use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    SUSDToken,
    CollateralToken, // The vault shares (SAC)
    VaultMetrics,   // The contract with total_assets/shares
    Oracle,
    CDP(Address),
    ICR, // Initial Collateralization Ratio (bps)
    MCR, // Maintenance Collateralization Ratio (bps)
    InterestRate, // Per second (scaled by 1e18)
    CumulativeIndex,
    LastUpdate,
    Initialized,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CDP {
    pub collateral: i128,
    pub debt_shares: i128,
    pub last_index: i128,
}

pub const SCALAR_18: i128 = 1_000_000_000_000_000_000;
pub const BPS_LIMIT: u32 = 10000;
