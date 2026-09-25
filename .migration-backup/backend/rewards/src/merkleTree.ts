import { createHash } from "crypto";

/** Maximum depth of a Merkle proof (supports trees up to 2^20 ≈ 1 M recipients). */
export const MAX_PROOF_DEPTH = 20;

/** Maximum number of entries allowed in a single batch distribution. */
export const MAX_BATCH_ENTRIES = 10_000;

/**
 * Validate that a proof array does not exceed the maximum allowed depth.
 * Returns an object so callers can surface a human-readable reason.
 */
export function validateProofSize(proof: string[]): { valid: boolean; reason?: string } {
  if (proof.length > MAX_PROOF_DEPTH) {
    return {
      valid: false,
      reason: `Proof depth ${proof.length} exceeds maximum allowed depth of ${MAX_PROOF_DEPTH}`,
    };
  }
  return { valid: true };
}

/**
 * Represents a single reward allocation for a user.
 */
export interface RewardEntry {
  /** Leaf index in the Merkle tree. */
  index: number;
  /** Stellar wallet address of the recipient. */
  address: string;
  /** Reward amount in stroops (1 YIELD = 10^7 stroops). */
  amount: string;
}

/**
 * The output of generating a Merkle tree: root hash and per-user proofs.
 */
export interface MerkleTreeResult {
  /** The 32-byte Merkle root as a hex string. */
  root: string;
  /** Per-user claim data with proofs. */
  claims: Record<
    string,
    {
      index: number;
      amount: string;
      proof: string[];
    }
  >;
}

/**
 * Compute the SHA-256 hash of a buffer.
 */
function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Compute a leaf hash matching the on-chain formula:
 * SHA256(index || address_bytes || amount).
 *
 * @param index   - The leaf index (uint32, big-endian).
 * @param address - The Stellar wallet address string.
 * @param amount  - The reward amount as a bigint-compatible string (int128, big-endian).
 */
export function computeLeaf(
  index: number,
  address: string,
  amount: string,
): Buffer {
  // Index as 4-byte big-endian
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32BE(index, 0);

  // Address as UTF-8 bytes (matches Soroban's Address::to_string().to_bytes())
  const addressBuf = Buffer.from(address, "utf-8");

  // Amount as 16-byte big-endian i128
  const amountBigInt = BigInt(amount);
  const amountBuf = Buffer.alloc(16);
  let val = amountBigInt;
  for (let i = 15; i >= 0; i--) {
    amountBuf[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }

  return sha256(Buffer.concat([indexBuf, addressBuf, amountBuf]));
}

/**
 * Hash two 32-byte values together in sorted order (smaller first).
 * Matches the on-chain `hash_pair` function.
 */
export function hashPair(a: Buffer, b: Buffer): Buffer {
  if (a.compare(b) <= 0) {
    return sha256(Buffer.concat([a, b]));
  }
  return sha256(Buffer.concat([b, a]));
}

/**
 * Generate a Merkle tree from a list of reward entries.
 *
 * Builds the tree bottom-up using sorted-pair hashing, then extracts
 * per-user proofs for on-chain verification.
 *
 * @param entries - The list of reward allocations.
 * @returns The Merkle root and per-user claim data with proofs.
 */
export function generateMerkleTree(entries: RewardEntry[]): MerkleTreeResult {
  if (entries.length === 0) {
    return { root: "0".repeat(64), claims: {} };
  }

  // Compute leaves
  const leaves: Buffer[] = entries.map((entry) =>
    computeLeaf(entry.index, entry.address, entry.amount),
  );

  // Build tree layers (bottom-up)
  const layers: Buffer[][] = [leaves];

  let currentLayer = leaves;
  while (currentLayer.length > 1) {
    const nextLayer: Buffer[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
      } else {
        // Odd node: promote to next level
        nextLayer.push(currentLayer[i]);
      }
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  const root = currentLayer[0].toString("hex");

  // Extract proofs for each leaf
  const claims: MerkleTreeResult["claims"] = {};

  for (const entry of entries) {
    const proof: string[] = [];
    let idx = entry.index;

    for (let layerIdx = 0; layerIdx < layers.length - 1; layerIdx++) {
      const layer = layers[layerIdx];
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx].toString("hex"));
      }

      idx = Math.floor(idx / 2);
    }

    claims[entry.address] = {
      index: entry.index,
      amount: entry.amount,
      proof,
    };
  }

  return { root, claims };
}

/**
 * Verify a single Merkle proof against a root.
 *
 * @param root    - The expected Merkle root (hex string).
 * @param index   - The leaf index.
 * @param address - The claimant address.
 * @param amount  - The claim amount.
 * @param proof   - The Merkle proof (array of hex strings).
 * @returns Whether the proof is valid.
 */
export function verifyProof(
  root: string,
  index: number,
  address: string,
  amount: string,
  proof: string[],
): boolean {
  let computed = computeLeaf(index, address, amount);

  for (const proofHex of proof) {
    const proofElement = Buffer.from(proofHex, "hex");
    computed = hashPair(computed, proofElement);
  }

  return computed.toString("hex") === root;
}

// ─── Claim preview validation (#964) ───────────────────────────────────────

/** A single 32-byte proof element must be exactly 64 lowercase/uppercase hex chars. */
const PROOF_ELEMENT_PATTERN = /^[0-9a-fA-F]{64}$/;
const ROOT_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Identifies the reward campaign a claim preview is checked against.
 */
export interface RewardCampaignInfo {
  /** Stable identifier for the distribution campaign (e.g. "2026-W22"). */
  campaignId: string;
  /** The Merkle root currently published on-chain for this campaign. */
  merkleRoot: string;
}

/**
 * A claim a client wants previewed before submitting a claim transaction.
 * `campaignId` and `merkleRoot` are whatever the client last cached — they
 * may be stale relative to the current campaign.
 */
export interface ClaimPreviewInput {
  campaignId: string;
  merkleRoot: string;
  index: number;
  address: string;
  amount: string;
  proof: string[];
}

export type ClaimPreviewState = "valid" | "invalid" | "stale";

export type ClaimPreviewErrorCode =
  | "campaign_id_mismatch"
  | "malformed_proof"
  | "root_mismatch"
  | "proof_verification_failed";

export interface ClaimPreviewResult {
  state: ClaimPreviewState;
  errorCode?: ClaimPreviewErrorCode;
  message: string;
}

/**
 * Structural validation of a proof array: every element must be a 32-byte
 * hex string, the depth must respect MAX_PROOF_DEPTH, and no sibling hash
 * may repeat (a well-formed Merkle proof never revisits the same node twice
 * — a repeated element is a sign of a truncated, replayed, or tampered proof).
 */
export function findProofShapeError(proof: string[]): string | null {
  if (!Array.isArray(proof)) {
    return "Proof must be an array of hex-encoded sibling hashes";
  }

  const sizeCheck = validateProofSize(proof);
  if (!sizeCheck.valid) {
    return sizeCheck.reason ?? "Proof exceeds maximum depth";
  }

  const seen = new Set<string>();
  for (const element of proof) {
    if (typeof element !== "string" || !PROOF_ELEMENT_PATTERN.test(element)) {
      return `Proof contains a malformed path element: "${String(element)}"`;
    }
    const normalized = element.toLowerCase();
    if (seen.has(normalized)) {
      return `Proof contains a duplicate path element: "${element}"`;
    }
    seen.add(normalized);
  }

  return null;
}

/**
 * Preview a reward claim before the caller submits an on-chain transaction.
 *
 * Validates, in order: the campaign ID matches the active campaign, the
 * proof array is well-formed (correct hex shape, bounded depth, no
 * duplicate path elements), the client's cached Merkle root matches the
 * campaign's current root (catching "root drift" — a proof generated
 * against a previous distribution), and finally that the proof
 * cryptographically verifies against the current root.
 *
 * @param input   - The claim the caller wants to preview.
 * @param current - The active campaign's canonical id and Merkle root.
 */
export function previewRewardClaim(
  input: ClaimPreviewInput,
  current: RewardCampaignInfo,
): ClaimPreviewResult {
  if (input.campaignId !== current.campaignId) {
    return {
      state: "invalid",
      errorCode: "campaign_id_mismatch",
      message: `Claim targets campaign "${input.campaignId}" but the active campaign is "${current.campaignId}".`,
    };
  }

  const shapeError = findProofShapeError(input.proof);
  if (shapeError) {
    return {
      state: "invalid",
      errorCode: "malformed_proof",
      message: shapeError,
    };
  }

  if (!ROOT_PATTERN.test(input.merkleRoot)) {
    return {
      state: "invalid",
      errorCode: "malformed_proof",
      message: `Merkle root "${input.merkleRoot}" is not a valid 32-byte hex value.`,
    };
  }

  if (input.merkleRoot.toLowerCase() !== current.merkleRoot.toLowerCase()) {
    return {
      state: "stale",
      errorCode: "root_mismatch",
      message:
        "This claim was generated against an earlier version of the reward tree. Refresh to fetch an updated proof.",
    };
  }

  const isValid = verifyProof(
    current.merkleRoot,
    input.index,
    input.address,
    input.amount,
    input.proof,
  );

  if (!isValid) {
    return {
      state: "invalid",
      errorCode: "proof_verification_failed",
      message: "This proof does not verify against the current reward tree.",
    };
  }

  return {
    state: "valid",
    message: "Claim proof is valid and can be submitted.",
  };
}
