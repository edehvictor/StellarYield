import {
  generateMerkleTree,
  verifyProof,
  type RewardEntry,
  type MerkleTreeResult,
} from "./merkleTree";

/**
 * Simulated reward calculation for users based on their vault share
 * balances. In production, this would query on-chain data and the
 * database for actual user positions and yield accrued.
 */
export interface UserRewardInput {
  /** Stellar wallet address. */
  address: string;
  /** User's vault shares balance. */
  shares: string;
  /** Total vault shares. */
  totalShares: string;
}

/**
 * Calculate weekly rewards for a set of users based on their
 * proportional share of the vault.
 *
 * @param users             - Array of user share balances.
 * @param totalWeeklyReward - Total $YIELD tokens to distribute this week (in stroops).
 * @returns Array of reward entries with computed amounts.
 */
export function calculateRewards(
  users: UserRewardInput[],
  totalWeeklyReward: string,
): RewardEntry[] {
  const totalReward = BigInt(totalWeeklyReward);
  const entries: RewardEntry[] = [];

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const shares = BigInt(user.shares);
    const totalShares = BigInt(user.totalShares);

    if (shares <= BigInt(0) || totalShares <= BigInt(0)) {
      continue;
    }

    const reward = (shares * totalReward) / totalShares;

    if (reward > BigInt(0)) {
      entries.push({
        index: entries.length,
        address: user.address,
        amount: reward.toString(),
      });
    }
  }

  return entries;
}

/**
 * Full pipeline: calculate rewards, generate Merkle tree, and return
 * the root + per-user proofs.
 *
 * @param users             - Array of user share balances.
 * @param totalWeeklyReward - Total $YIELD to distribute in stroops.
 * @returns Merkle tree result with root and claims.
 */
export function generateWeeklyDistribution(
  users: UserRewardInput[],
  totalWeeklyReward: string,
): MerkleTreeResult {
  const entries = calculateRewards(users, totalWeeklyReward);
  return generateMerkleTree(entries);
}

/**
 * Lookup a user's claim proof from a distribution result.
 *
 * @param address     - The user's Stellar address.
 * @param distribution - The distribution result.
 * @returns The user's claim data or null if not found.
 */
export function getUserProof(
  address: string,
  distribution: MerkleTreeResult,
): { index: number; amount: string; proof: string[] } | null {
  return distribution.claims[address] ?? null;
}

export { generateMerkleTree, verifyProof };
export type { RewardEntry, MerkleTreeResult };
