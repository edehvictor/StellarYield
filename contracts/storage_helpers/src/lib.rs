#![no_std]

use soroban_sdk::{Env, IntoVal, TryFromVal};

// Standard constants for TTL extension
pub const LOW_WATERMARK_LEDGERS: u32 = 50_000;
pub const BUMP_LEDGER_AMOUNT: u32 = 100_000;

/// Extends the TTL for instance storage if it is below the low watermark
pub fn extend_instance_ttl(e: &Env, threshold: u32, extend_to: u32) {
    e.storage().instance().extend_ttl(threshold, extend_to);
}

/// Extends the TTL for a persistent storage key if it is below the low watermark
pub fn extend_persistent_ttl<K>(e: &Env, key: &K, threshold: u32, extend_to: u32) 
where
    K: IntoVal<Env, soroban_sdk::Val> + TryFromVal<Env, soroban_sdk::Val> + Clone,
{
    e.storage().persistent().extend_ttl(key, threshold, extend_to);
}

/// Extends instance storage with default constants
pub fn extend_instance_ttl_default(e: &Env) {
    extend_instance_ttl(e, LOW_WATERMARK_LEDGERS, BUMP_LEDGER_AMOUNT);
}

/// Extends persistent storage key with default constants
pub fn extend_persistent_ttl_default<K>(e: &Env, key: &K)
where
    K: IntoVal<Env, soroban_sdk::Val> + TryFromVal<Env, soroban_sdk::Val> + Clone,
{
    extend_persistent_ttl(e, key, LOW_WATERMARK_LEDGERS, BUMP_LEDGER_AMOUNT);
}
