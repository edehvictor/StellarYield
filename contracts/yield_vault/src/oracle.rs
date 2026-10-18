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
    pub confidence: u32, // 0-100: confidence score based on sample quality and age
}

/// Maximum age of an oracle observation that may be used directly.
const MAX_OBSERVATION_AGE: u64 = 900;

/// A price is valid only when it is positive, timestamped in the past, and
/// fresh enough to describe current market conditions.
fn is_valid_observation(price: i128, timestamp: u64, now: u64) -> bool {
    price > 0
        && timestamp > 0
        && timestamp <= now
        && now.saturating_sub(timestamp) < MAX_OBSERVATION_AGE
}

impl YieldVault {
    pub fn set_oracle(env: Env, admin: Address, oracle: Address) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Oracle, &oracle);
        Ok(())
    }

    /// Fetches the current price from the oracle, or calculates TWAP if stale.
    /// Returns (price, confidence_score, is_fallback).
    pub fn get_secure_price_with_metadata(env: &Env) -> Result<(i128, u32, bool), VaultError> {
        let oracle_addr: Option<Address> = env.storage().instance().get(&DataKey::Oracle);

        // Legacy deposit/withdraw flows can still operate without an oracle.
        let Some(oracle_addr) = oracle_addr else {
            return Ok((1, 100, false));
        };

        let token_addr: Address = Self::get_storage_required(env, &DataKey::Token)?;
        let client = OracleClient::new(env, &oracle_addr);
        let now = env.ledger().timestamp();

        if let Some((price, timestamp)) = client.get_price(&token_addr) {
            // Invalid observations must never influence share minting.
            if price <= 0 || timestamp == 0 || timestamp > now {
                env.events().publish(
                    (
                        soroban_sdk::symbol_short!("oracle"),
                        soroban_sdk::symbol_short!("invalid"),
                    ),
                    (price, timestamp, now),
                );
                return Err(VaultError::InvalidPrice);
            }

            let age_seconds = now.saturating_sub(timestamp);

            // Fresh price (< 15 mins): high confidence
            if age_seconds < MAX_OBSERVATION_AGE {
                let confidence = Self::calculate_confidence(age_seconds, 1);
                Self::update_price_history(env, price, now, confidence);
                env.events().publish(
                    (
                        soroban_sdk::symbol_short!("oracle"),
                        soroban_sdk::symbol_short!("fresh"),
                    ),
                    (price, confidence),
                );
                return Ok((price, confidence, false));
            }

            // Stale price: emit event and fallback to TWAP
            env.events().publish(
                (
                    soroban_sdk::symbol_short!("oracle"),
                    soroban_sdk::symbol_short!("stale"),
                ),
                age_seconds,
            );
        }

        // Fallback: use TWAP with reduced confidence
        let (twap_price, samples) = Self::calculate_twap_with_samples(env)?;
        let confidence = Self::calculate_twap_confidence(env, samples);

        env.events().publish(
            (
                soroban_sdk::symbol_short!("twap"),
                soroban_sdk::symbol_short!("used"),
            ),
            (twap_price, confidence, samples),
        );

        Ok((twap_price, confidence, true))
    }

    /// Legacy wrapper for backward compatibility.
    pub fn get_secure_price(env: &Env) -> Result<i128, VaultError> {
        let (price, confidence, _) = Self::get_secure_price_with_metadata(env)?;

        // Block sensitive operations if confidence too low
        if confidence < 50 {
            return Err(VaultError::InvalidPrice);
        }

        Ok(price)
    }

    fn update_price_history(env: &Env, price: i128, timestamp: u64, confidence: u32) {
        let mut history: Vec<PricePoint> = env
            .storage()
            .instance()
            .get(&soroban_sdk::Symbol::new(env, "history"))
            .unwrap_or(Vec::new(env));

        history.push_front(PricePoint {
            price,
            timestamp,
            confidence,
        });

        // Keep only last 10 points
        if history.len() > 10 {
            history.pop_back();
        }

        env.storage()
            .instance()
            .set(&soroban_sdk::Symbol::new(env, "history"), &history);
    }

    /// Calculate confidence score based on price age.
    /// 0-100 scale: 100 = fresh, 0 = very stale.
    fn calculate_confidence(age_seconds: u64, sample_quality: u32) -> u32 {
        // Confidence degrades with age: 100% at 0s, 50% at 900s (15 min)
        let age_factor = if age_seconds >= 900 {
            0
        } else {
            100 - ((age_seconds * 50) / 900) as u32
        };

        // Combine age and sample quality
        ((age_factor * sample_quality) / 100).min(100)
    }

    /// Calculate TWAP confidence based on sample count and price volatility.
    fn calculate_twap_confidence(env: &Env, sample_count: u32) -> u32 {
        let history: Vec<PricePoint> = env
            .storage()
            .instance()
            .get(&soroban_sdk::Symbol::new(env, "history"))
            .unwrap_or(Vec::new(env));

        if history.is_empty() {
            return 0;
        }

        // Base confidence from sample count (min 3 samples for decent confidence)
        let sample_confidence: u32 = if sample_count >= 10 {
            80
        } else if sample_count >= 5 {
            60
        } else if sample_count >= 3 {
            40
        } else {
            20
        };

        // Calculate price volatility penalty
        let now = env.ledger().timestamp();
        let mut prices: Vec<i128> = Vec::new(env);
        for p in history.iter() {
            if is_valid_observation(p.price, p.timestamp, now) {
                prices.push_back(p.price);
            }
        }
        let volatility_penalty = Self::calculate_volatility_penalty(&prices);

        sample_confidence.saturating_sub(volatility_penalty)
    }

    /// Calculate volatility penalty (0-30) based on price deviation.
    fn calculate_volatility_penalty(prices: &Vec<i128>) -> u32 {
        if prices.len() < 2 {
            return 0;
        }

        let mut sum: i128 = 0;
        for price in prices.iter() {
            sum += price;
        }
        let avg = sum / prices.len() as i128;

        let mut max_deviation = 0i128;
        for price in prices.iter() {
            let deviation = if price > avg {
                price - avg
            } else {
                avg - price
            };
            if deviation > max_deviation {
                max_deviation = deviation;
            }
        }

        let deviation_pct = if avg > 0 {
            (max_deviation * 100) / avg
        } else {
            0
        };

        // Penalize high volatility: 0-5% = 0 penalty, 5-15% = 15 penalty, 15%+ = 30 penalty
        if deviation_pct <= 5 {
            0
        } else if deviation_pct <= 15 {
            15
        } else {
            30
        }
    }

    fn calculate_twap(env: &Env) -> Result<i128, VaultError> {
        let (price, _) = Self::calculate_twap_with_samples(env)?;
        Ok(price)
    }

    fn calculate_twap_with_samples(env: &Env) -> Result<(i128, u32), VaultError> {
        let history: Vec<PricePoint> = env
            .storage()
            .instance()
            .get(&soroban_sdk::Symbol::new(env, "history"))
            .ok_or(VaultError::InvalidPrice)?;

        if history.is_empty() {
            return Err(VaultError::InvalidPrice);
        }

        let now = env.ledger().timestamp();
        let mut sum_price = 0i128;
        let mut sample_count = 0u32;

        for point in history.iter() {
            if is_valid_observation(point.price, point.timestamp, now) {
                sum_price += point.price;
                sample_count += 1;
            }
        }

        // Require at least 2 valid, non-stale samples for TWAP
        if sample_count < 2 {
            return Err(VaultError::InvalidPrice);
        }

        Ok((sum_price / (sample_count as i128), sample_count))
    }
}
