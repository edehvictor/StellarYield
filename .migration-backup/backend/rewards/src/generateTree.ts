import { createHash } from "crypto";
import { execSync } from "child_process";
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

// ─── Artifact Manifest (#997) ─────────────────────────────────────────────────

/**
 * Provenance manifest attached to a generated reward artifact.
 * Records exactly which inputs produced a given Merkle root so that
 * maintainers (and auditors) can re-derive the root from the raw inputs
 * and confirm it matches. The manifest is meant to be stored alongside
 * the distribution artifact (e.g. written to the same output directory).
 */
export interface RewardArtifactManifest {
  /** Unique identifier for the distribution campaign (e.g. "2026-W22"). */
  campaignId: string;
  /** The Merkle root that was produced from the inputs below. */
  merkleRoot: string;
  /**
   * SHA-256 hex digest of the canonical JSON representation of the input
   * RewardEntry array (sorted by index, serialised as
   * `JSON.stringify(entries)`). Anyone with the original input file can
   * recompute this hash and compare it to detect tampering.
   */
  inputHash: string;
  /** Total number of recipients included in this distribution. */
  recipientCount: number;
  /** Sum of all reward amounts (in stroops) as a string to avoid precision loss. */
  totalAmount: string;
  /** ISO-8601 UTC timestamp when the artifact was generated. */
  generatedAt: string;
  /**
   * Semantic version of the rewards tool that produced this artifact.
   * Sourced from package.json at generation time when available.
   */
  toolVersion: string | null;
  /**
   * Short SHA of the git commit that was checked out when the artifact was
   * generated. Null when not inside a git repository or when git is
   * unavailable.
   */
  sourceCommit: string | null;
}

/** Options for artifact manifest generation. */
export interface GenerateManifestOptions {
  /** Override the current UTC timestamp (useful in tests). */
  now?: Date;
  /** Override the tool version (defaults to package.json version). */
  toolVersion?: string | null;
  /** Override the source commit (defaults to `git rev-parse --short HEAD`). */
  sourceCommit?: string | null;
}

/**
 * Read the package version from `package.json` in this workspace.
 * Returns null if the file cannot be read or has no version field.
 */
function readToolVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Retrieve the short git commit SHA for the current HEAD.
 * Returns null when not inside a git repository or git is unavailable.
 */
function readSourceCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Compute the SHA-256 input hash over the canonical JSON of the entries.
 * The canonical form is `JSON.stringify(entries)` where entries are passed
 * as-is (callers should ensure they are sorted by index for reproducibility).
 */
function computeInputHash(entries: RewardEntry[]): string {
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

/**
 * Build a provenance manifest for a reward distribution artifact.
 *
 * @param campaignId - Stable campaign identifier (e.g. "2026-W22").
 * @param entries    - The exact RewardEntry array that was fed to `generateMerkleTree`.
 * @param result     - The MerkleTreeResult returned by `generateMerkleTree`.
 * @param options    - Optional overrides for timestamp, version, and commit.
 */
export function buildArtifactManifest(
  campaignId: string,
  entries: RewardEntry[],
  result: MerkleTreeResult,
  options: GenerateManifestOptions = {},
): RewardArtifactManifest {
  const totalAmount = entries
    .reduce((sum, e) => sum + BigInt(e.amount), BigInt(0))
    .toString();

  return {
    campaignId,
    merkleRoot: result.root,
    inputHash: computeInputHash(entries),
    recipientCount: entries.length,
    totalAmount,
    generatedAt: (options.now ?? new Date()).toISOString(),
    toolVersion: "toolVersion" in options ? (options.toolVersion ?? null) : readToolVersion(),
    sourceCommit: "sourceCommit" in options ? (options.sourceCommit ?? null) : readSourceCommit(),
  };
}

/**
 * Validate an existing manifest against a set of RewardEntries and a
 * MerkleTreeResult.  Returns null on success or a human-readable error
 * string describing the first violation found.
 *
 * Use this as the basis of the `validate-manifest` CLI command (see index.ts).
 */
export function validateArtifactManifest(
  manifest: RewardArtifactManifest,
  entries: RewardEntry[],
  result: MerkleTreeResult,
): string | null {
  if (manifest.merkleRoot !== result.root) {
    return `merkleRoot mismatch: manifest has "${manifest.merkleRoot}" but computed root is "${result.root}"`;
  }

  const expectedInputHash = computeInputHash(entries);
  if (manifest.inputHash !== expectedInputHash) {
    return `inputHash mismatch: manifest has "${manifest.inputHash}" but computed hash is "${expectedInputHash}"`;
  }

  if (manifest.recipientCount !== entries.length) {
    return `recipientCount mismatch: manifest has ${manifest.recipientCount} but entries has ${entries.length}`;
  }

  const expectedTotal = entries
    .reduce((sum, e) => sum + BigInt(e.amount), BigInt(0))
    .toString();
  if (manifest.totalAmount !== expectedTotal) {
    return `totalAmount mismatch: manifest has "${manifest.totalAmount}" but computed total is "${expectedTotal}"`;
  }

  return null;
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
 * Full pipeline with provenance: calculate rewards, generate Merkle tree,
 * and attach a manifest recording the campaign, input hash, totals, and
 * tool/commit metadata.
 *
 * @param campaignId        - Stable campaign identifier (e.g. "2026-W22").
 * @param users             - Array of user share balances.
 * @param totalWeeklyReward - Total $YIELD to distribute in stroops.
 * @param options           - Optional overrides for manifest fields.
 * @returns The tree result and its provenance manifest.
 */
export function generateWeeklyDistributionWithManifest(
  campaignId: string,
  users: UserRewardInput[],
  totalWeeklyReward: string,
  options: GenerateManifestOptions = {},
): { result: MerkleTreeResult; manifest: RewardArtifactManifest } {
  const entries = calculateRewards(users, totalWeeklyReward);
  const result = generateMerkleTree(entries);
  const manifest = buildArtifactManifest(campaignId, entries, result, options);
  return { result, manifest };
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
