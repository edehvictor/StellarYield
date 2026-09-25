use soroban_sdk::Env;

use crate::VaultError;

/// EIP-4626 style tokenized vault standard for Soroban.
///
/// This trait defines the standard interface for vault contracts,
/// inspired by Ethereum's ERC-4626 Tokenized Vault Standard.
/// Implementations must ensure proper rounding:
/// - Deposits: round UP (favor the vault)
/// - Withdrawals: round DOWN (favor the user)
///
/// # Rounding Rules
///
/// - `convert_to_shares`: Round UP (users get fewer shares for their assets)
/// - `convert_to_assets`: Round DOWN (users get fewer assets for their shares)
/// - `preview_deposit`: Round UP (users get realistic estimate, actual may be slightly less)
/// - `preview_withdraw`: Round DOWN (users get realistic estimate, actual may be slightly less)
///
/// # Security
///
/// All implementations must handle edge cases:
/// - Zero supply: first deposit mints shares 1:1 with assets
/// - Zero amount: return 0 or error depending on context
/// - Overflow: use checked arithmetic for all calculations
#[allow(dead_code)]
pub trait VaultStandard {
    /// Returns the total amount of underlying assets held by the vault.
    ///
    /// # Returns
    /// The total assets under management, in the vault's base token.
    fn total_assets(env: Env) -> Result<i128, VaultError>;

    /// Convert an asset amount to the equivalent number of shares at current price.
    ///
    /// # Rounding
    /// Rounds UP to prevent rounding error exploits (users get fewer shares).
    ///
    /// # Arguments
    /// * `assets` - Amount of assets to convert
    ///
    /// # Returns
    /// Number of shares that would be received for `assets` amount at current price.
    fn convert_to_shares(env: Env, assets: i128) -> Result<i128, VaultError>;

    /// Convert a share amount to the equivalent number of assets at current price.
    ///
    /// # Rounding
    /// Rounds DOWN to prevent rounding error exploits (users get fewer assets).
    ///
    /// # Arguments
    /// * `shares` - Number of shares to convert
    ///
    /// # Returns
    /// Amount of assets that would be received for `shares` at current price.
    fn convert_to_assets(env: Env, shares: i128) -> Result<i128, VaultError>;

    /// Preview the number of shares that would be minted for a deposit.
    ///
    /// # Rounding
    /// Rounds UP to give users a conservative estimate.
    ///
    /// # Arguments
    /// * `assets` - Amount of assets to deposit
    ///
    /// # Returns
    /// Number of shares that would be minted.
    fn preview_deposit(env: Env, assets: i128) -> Result<i128, VaultError>;

    /// Preview the number of assets that would be returned for a withdrawal.
    ///
    /// # Rounding
    /// Rounds DOWN to give users a conservative estimate.
    ///
    /// # Arguments
    /// * `shares` - Number of shares to redeem
    ///
    /// # Returns
    /// Amount of assets that would be returned.
    fn preview_withdraw(env: Env, shares: i128) -> Result<i128, VaultError>;

    /// Preview the number of shares needed to withdraw a specific asset amount.
    ///
    /// # Rounding
    /// Rounds UP to favor the vault (user needs more shares).
    ///
    /// # Arguments
    /// * `assets` - Desired amount of assets to withdraw
    ///
    /// # Returns
    /// Number of shares needed to withdraw `assets`.
    fn preview_redeem(env: Env, assets: i128) -> Result<i128, VaultError>;

    /// Get the price per share in asset terms.
    ///
    /// # Returns
    /// The value of one share in terms of the underlying asset.
    /// Returns a fixed-point number where 1e18 = 1.0.
    fn share_price(env: Env) -> Result<i128, VaultError>;
}
