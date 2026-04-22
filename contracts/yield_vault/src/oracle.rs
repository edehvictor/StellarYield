use crate::{DataKey, VaultError, YieldVault};
use soroban_sdk::{contractclient, contracttype, Address, Env, Vec};

#[contractclient(name = "OracleClient")]
#[allow(dead_code)]
pub trait OracleInterface {
    fn get_price(env: Env, asset: Address) -> Option<(i128, u64)>;
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PricePoint {
    pub price: i128,
    pub timestamp: u64,
}

impl YieldVault {
    pub fn set_oracle(env: Env, admin: Address, oracle: Address) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        Ok(())
    }

    /// Fetches the current price from the oracle, or calculates TWAP if stale.
    pub fn get_secure_price(env: &Env) -> Result<i128, VaultError> {
        let oracle_addr: Option<Address> = env.storage().instance().get(&DataKey::Oracle);

        // Legacy deposit/withdraw flows can still operate without an oracle.
        // When an oracle is configured we enforce the secure-price path below.
        let Some(oracle_addr) = oracle_addr else {
            return Ok(1);
        };

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();

        let client = OracleClient::new(env, &oracle_addr);
        let now = env.ledger().timestamp();

        if let Some((price, timestamp)) = client.get_price(&token_addr) {
            // If price is fresh (last 15 mins), use it.
            if now < timestamp + 900 {
                // Record for TWAP tracking
                Self::update_price_history(env, price, now);
                return Ok(price);
            }
        }

        // If oracle stale/failed, use TWAP fallback
        Self::calculate_twap(env)
    }

    fn update_price_history(env: &Env, price: i128, timestamp: u64) {
        let mut history: Vec<PricePoint> = env
            .storage()
            .instance()
            .get(&soroban_sdk::Symbol::new(env, "history"))
            .unwrap_or(Vec::new(env));

        history.push_front(PricePoint { price, timestamp });

        // Keep only last 10 points
        if history.len() > 10 {
            history.pop_back();
        }

        env.storage()
            .instance()
            .set(&soroban_sdk::Symbol::new(env, "history"), &history);
    }

    fn calculate_twap(env: &Env) -> Result<i128, VaultError> {
        let history: Vec<PricePoint> = env
            .storage()
            .instance()
            .get(&soroban_sdk::Symbol::new(env, "history"))
            .ok_or(VaultError::InvalidPrice)?;

        if history.is_empty() {
            return Err(VaultError::InvalidPrice);
        }

        let mut sum_price = 0i128;
        for point in history.iter() {
            sum_price += point.price;
        }

        Ok(sum_price / (history.len() as i128))
    }
}
