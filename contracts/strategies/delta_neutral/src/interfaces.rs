use soroban_sdk::{contractclient, Address, Env};

/// Minimal interface for the AMM router (e.g. Soroswap).
/// The contract calls `swap_exact_tokens_for_tokens` to convert USDC → spot asset.
#[contractclient(name = "AmmRouterClient")]
pub trait AmmRouterInterface {
    /// Swap `amount_in` of `token_in` for at least `amount_out_min` of `token_out`.
    /// Returns the actual amount of `token_out` received.
    fn swap_exact_tokens_for_tokens(
        env: Env,
        sender: Address,
        amount_in: i128,
        amount_out_min: i128,
        token_in: Address,
        token_out: Address,
    ) -> i128;
}

/// Minimal interface for the Perpetuals exchange.
/// Supports opening and closing 1x short positions.
#[contractclient(name = "PerpExchangeClient")]
pub trait PerpExchangeInterface {
    /// Open a 1x short position with `collateral` USDC.
    /// Returns the notional size of the position (scaled 1e7).
    fn open_short(env: Env, trader: Address, collateral: i128, asset: Address) -> i128;

    /// Close an existing short position for `trader`.
    /// Returns the USDC proceeds (collateral ± PnL).
    fn close_short(env: Env, trader: Address, asset: Address) -> i128;

    /// Collect accrued funding rate for `trader`'s short position.
    /// Returns the funding amount in USDC.
    fn collect_funding(env: Env, trader: Address, asset: Address) -> i128;
}

/// Minimal oracle interface for spot price feeds.
#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    /// Returns the current price of `asset` in USDC, scaled by 1e7.
    fn get_price(env: Env, asset: Address) -> i128;
}
