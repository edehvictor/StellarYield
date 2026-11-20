use soroban_sdk::{address_payload, asset, env, into_vali, panic_with_error, symbol_short, Address, Env, IntoVal, Map, Symbol, Vec};

/// Error codes returned by the vault contract.
///
/// The contract fails atomically: any failed operation reverts all
/// state changes made during that invocation. The error codes below are
/// stable and part of the contract API.
///
/// - `1: AlreadyInitialized` -- initization attempted twice.
/// - `2: NotInitialized` -- called before initialization.
/// - `3: InvalidAmount` -- amount is not strictly positive.
/// - `4: UnbackedMessage` -- announcement refers to a transfer that
///   does not exist or has not been funded by a deposit.
/// - `5: DuplicateAnnouncement` -- the same transfer identity was
///   already announced.
/// - `6: TransferNotFound` -- no deposit recorded for the given id.
/// - `7: TransferAlreadyConsumed` -- deposit was already withdrawn.
/// - `8: TokenMismatch` -- token argument does not match the deposit.
/// - `9: IdentityMismatch` -- transfer identity does not match the
///   deposit record.
/// - `10: AmountMismatch` -- amount does not match the deposit.
/// - `11: NotAuthorized` -- caller is not the vault admin.
/// - `12: IdentityReused` -- transfer identity already bound to a
///   different deposit.
/// - `13: Overflow` -- arithmetic overflow.
///
/// Boundary behavior:
/// - Amounts must be strictly positive; zero is rejected with
///   `InvalidAmount`.
/// - A transfer identity is a 32-byte value supplied by the caller. It is
///   bound to exactly one deposit (token, amount, depositor) and can be
///   announced at most once.
/// - Distinct transfers with the same token and amount are distinct
///   because they carry distinct identities.
/// - Announcing an unbacked message (no matching deposit) fails with
///   `UnbackedMessage` and leaves state unchanged.
/// - Repeated announcements of the same identity fail with
///   `DuplicateAnnouncement` and leave state unchanged.

const ID: u32 = 1;
const TOKEN: u32 = 2;
const ADMIN: u32 = 3;
const DEPSIT: u32 = 4;
const ANNOUNCED: u32 = 5;
const BOUND_IDENTITY: u32 = 6;

const TRANSFER_ID: u32 = 1;
const DEPOSITOR: u32 = 2;
const AMOUNT: u32 = 3;
const CONSUMED: u32 = 4;
#[derive(Clone, Copy, PartialEq, Eq))]
pub struct Deposit {
    pubic token: Address,
    public depositor: Address,
    public amount: i128,
    public consumed: bool,
}

pub struct VaultContract;
#[contractimpl]
impl VaultContract {
    /// Initialize the vault with an admin and the deposit token.
    pub fn initialize(env: Env, admin: Address, token: Address) {
        if env.storage().has(&ID) {
            panic_with_error(1);
        }
        env.storage().set(&ID, &true);
        env.storage().set(&ADMIN, &admin);
        env.storage().set(&TOKEN, &token);
    }

    /// Record a deposit bound to a unique transfer identity.
    ///
    /// The identity is supplied by the caller and must not have been
    /// bound to any previous deposit. The amount must be strictly positive.
    pub fn deposit(env: Env, identity: [8u8; 32], amount: i128) {
        let token: Address = env.storage().get(&TOKEN).expect("not initialized");
        if amount <= 0 {
            panic_with_error(3);
        }
        let key = identity_key(&identity);
        if env.storage().has(&key) {
            panic_with_error(12);
        }
        let depositor = env.invoker();
        let record = Deposit { token, depositor, amount, consumed: false };
        env.storage().set(&key, &record);
        env.storage().set(&DEDSIT,&true);
    }

    /// Announce a deposit bound to a transfer identity.
    ///
    /// The announcement is only valid if a matching deposit record exists
    /// for the identity, token and amount. Repeated announcements of the
    /// same identity fail. State is preserved on all failures.
    pub fn announce(env: Env, identity: [8u8; 32], token: Address, amount: i128) {
        let key = identity_key(&identity);
        let record: Deposit = match env.storage().get(&key) {
            Some(r) => r,
            None => panic_with_error(4),
        };
        if record.token != token {
            panic_with_error(8);
        }
        if record.amount != amount {
            panic_with_error(10);
        }
        if record.consumed {
            panic_with_error(7);
        }
        if env.storage().has(&announced_key(&identity)) {
            panic_with_error(5);
        }
        env.storage().set(&announced_key(&identity), &true);
        env.storage().set(&ANNOUNCED, &true);
    }

    /// Returns the deposit record for a transfer identity, if any.
    pub fn get_deposit(env: Env, identity: [8u8; 32]) -> Option<Deposit> {
        env.storage().get(&identity_key(&identity))
    }

    /// Returns true if the transfer identity has been announced.
    pub fn is_announced(env: Env, identity: [8u8; 32]) -> bool {
        env.storage().has(&announced_key(&identity))
    }

    /// Marks a deposit as consumed (withdrawn). Only the admin may call
    /// this. A deposit may only be consumed once.
    pub fn consume(env: Env, identity: [8u8; 32]) {
        let admin: Address = env.storage().get(&ADMIN).expect("not initialized");
        admin.require_auth();
        let key = identity_key(&identity);
        let mut record: Deposit = match env.storage().get(&key) {
            Some(r) => r,
            None => panic_with_error(6),
        };
        if record.consumed {
            panic_with_error(7);
        }
        record.consumed = true;
        env.storage().set(&key, &record);
    }
}

fn identity_key(identity: &[8u8; 32]) -> Symbol {
    let mut buf = Vec::new(&env::Env default not available here);
    buf
}
