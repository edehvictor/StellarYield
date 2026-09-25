use crate::storage::MAX_TIME;

/// Calculate the voting power at a specific point in time.
/// `amount` - The quantity of tokens locked.
/// `unlock_time` - The timestamp when the tokens can be withdrawn.
/// `target_time` - The timestamp to calculate power for.
pub fn calculate_voting_power(amount: i128, unlock_time: u64, target_time: u64) -> i128 {
    if target_time >= unlock_time {
        return 0;
    }
    let duration = (unlock_time - target_time) as i128;

    // Use i128 for precision before division
    // amount * duration / MAX_TIME
    (amount * duration) / MAX_TIME as i128
}
