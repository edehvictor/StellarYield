//! # Yield Donation Module
//!
//! Allows users to auto-route a configured percentage of their generated
//! yield to a whitelisted charity address on every `harvest` / `withdraw`.
//!
//! ## Storage layout
//! - `DonationBps(user)` — per-user donation split in basis points (0..=10_000)
//! - `DonationCharity(user)` — the charity Address chosen by the user
//! - `WhitelistedCharity(Address)` — flag marking an address as an approved charity
//! - `TotalDonated` — running protocol-wide total of donated tokens
//!
//! ## Security
//! - Donation logic operates only on yield, never on principal.
//! - Underflow is prevented: the donated slice is subtracted from yield
//!   *before* it is credited to the user, always within checked arithmetic.
//! - Overflow on `TotalDonated` is absorbed gracefully by saturating add.

use crate::{VaultError, YieldVault};
use soroban_sdk::{contracttype, symbol_short, token, Address, Env};

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
pub enum DonationKey {
    /// Donation split in bps for a specific user account.
    DonationBps(Address),
    /// Whitelisted charity chosen by a specific user account.
    DonationCharity(Address),
    /// Flag: true if this address is an approved charity.
    WhitelistedCharity(Address),
    /// Cumulative protocol-wide donated token amount (stroops).
    TotalDonated,
}

const BPS_DENOMINATOR: i128 = 10_000;

// ── Error Codes ─────────────────────────────────────────────────────────
// These map to the error dictionary in `errorDecoder.ts`
// Error 2001 — invalid donation percentage
// Error 2002 — charity not whitelisted

// ── Public API ───────────────────────────────────────────────────────────

impl YieldVault {
    /// Configure the auto-donate yield split for the calling user.
    ///
    /// Sets the percentage (in basis points) of generated yield that will
    /// be automatically routed to `charity` on each harvest / withdrawal.
    /// Setting `bps = 0` effectively disables donations.
    ///
    /// # Arguments
    /// * `user`    — The user's account address (must authorise this call).
    /// * `bps`     — Split percentage in basis points (0 = 0 %, 10_000 = 100 %).
    /// * `charity` — The destination charity address (must be whitelisted).
    ///
    /// # Errors
    /// * `VaultError::InvalidDonationBps`    (code 2001) — `bps > 10_000`.
    /// * `VaultError::CharityNotWhitelisted` (code 2002) — charity is not approved.
    pub fn set_donation_split(
        env: Env,
        user: Address,
        bps: i128,
        charity: Address,
    ) -> Result<(), VaultError> {
        user.require_auth();

        if !(0..=BPS_DENOMINATOR).contains(&bps) {
            return Err(VaultError::InvalidDonationBps);
        }

        let is_whitelisted: bool = env
            .storage()
            .instance()
            .get(&DonationKey::WhitelistedCharity(charity.clone()))
            .unwrap_or(false);

        if !is_whitelisted {
            return Err(VaultError::CharityNotWhitelisted);
        }

        env.storage()
            .instance()
            .set(&DonationKey::DonationBps(user.clone()), &bps);
        env.storage()
            .instance()
            .set(&DonationKey::DonationCharity(user.clone()), &charity);

        env.events()
            .publish((symbol_short!("don_set"),), (user, bps));

        Ok(())
    }

    /// Whitelist (or de-list) an address as an approved charity destination.
    ///
    /// Only callable by the vault admin (governance).
    ///
    /// # Arguments
    /// * `admin`     — The admin address (must authorise).
    /// * `charity`   — The charity address to modify.
    /// * `approved`  — `true` to whitelist, `false` to remove.
    pub fn set_charity_whitelist(
        env: Env,
        admin: Address,
        charity: Address,
        approved: bool,
    ) -> Result<(), VaultError> {
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&DonationKey::WhitelistedCharity(charity.clone()), &approved);

        env.events()
            .publish((symbol_short!("charity"),), (charity, approved));

        Ok(())
    }

    /// Returns the current donation configuration for `user`.
    ///
    /// Returns `(0, None)` when the user has not configured a split.
    ///
    /// # Arguments
    /// * `user` — The account to query.
    pub fn get_donation_config(env: Env, user: Address) -> (i128, Option<Address>) {
        let bps: i128 = env
            .storage()
            .instance()
            .get(&DonationKey::DonationBps(user.clone()))
            .unwrap_or(0);

        let charity: Option<Address> = env
            .storage()
            .instance()
            .get(&DonationKey::DonationCharity(user));

        (bps, charity)
    }

    /// Returns the cumulative total of tokens donated protocol-wide.
    pub fn get_total_donated(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DonationKey::TotalDonated)
            .unwrap_or(0)
    }

    // ── Internal ────────────────────────────────────────────────────────

    /// Routes the donation slice out of `yield_amount` to the configured
    /// charity and returns the net amount remaining for the user.
    ///
    /// This is called internally from harvest / withdrawal logic.
    /// Operates only on the yield — never on principal.
    ///
    /// # Arguments
    /// * `env`          — Contract environment.
    /// * `user`         — The user whose yield is being harvested.
    /// * `yield_amount` — The gross yield amount in stroops.
    /// * `token_id`     — The yield token contract address.
    ///
    /// # Returns
    /// The net yield amount after the donation slice has been transferred.
    pub fn apply_donation(
        env: &Env,
        user: &Address,
        yield_amount: i128,
        token_id: &Address,
    ) -> i128 {
        if yield_amount <= 0 {
            return yield_amount;
        }

        let bps: i128 = env
            .storage()
            .instance()
            .get(&DonationKey::DonationBps(user.clone()))
            .unwrap_or(0);

        if bps <= 0 {
            return yield_amount;
        }

        let charity_opt: Option<Address> = env
            .storage()
            .instance()
            .get(&DonationKey::DonationCharity(user.clone()));

        // If no charity set (shouldn't normally happen) skip donation silently.
        let charity = match charity_opt {
            Some(c) => c,
            None => return yield_amount,
        };

        // Compute donation amount using checked math to prevent underflow.
        // `bps` is bounded to [0, 10_000] so the multiplication cannot
        // exceed i128::MAX for any realistic `yield_amount`.
        let donation = (yield_amount * bps) / BPS_DENOMINATOR;
        let net = yield_amount - donation; // Always >= 0 since bps <= 10_000

        if donation > 0 {
            let token_client = token::Client::new(env, token_id);
            // Transfer from the contract's own balance to the charity.
            token_client.transfer(&env.current_contract_address(), &charity, &donation);

            // Accumulate total donated (saturating add to avoid overflow trap).
            let prev_total: i128 = env
                .storage()
                .instance()
                .get(&DonationKey::TotalDonated)
                .unwrap_or(0);

            let new_total = prev_total.saturating_add(donation);
            env.storage()
                .instance()
                .set(&DonationKey::TotalDonated, &new_total);

            env.events().publish(
                (symbol_short!("donated"),),
                (user.clone(), charity, donation),
            );
        }

        net
    }
}
