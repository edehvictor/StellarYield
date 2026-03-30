import { createHash } from "crypto";

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
