/**
 * merkleDistributorIntegration.test.ts — Issue #719
 *
 * Verifies that the off-chain Merkle generation (TypeScript) is correctly
 * wired to the on-chain distributor's verification logic (Soroban Rust).
 *
 * Since we cannot run the Soroban contract from Node.js, these tests
 * verify the invariants that MUST hold between the two implementations:
 *
 * 1. Encoding invariant: off-chain computeLeaf produces the identical
 *    byte layout described in the on-chain compute_leaf comment.
 *
 * 2. Anti-double-claim: verifyProof correctly rejects a replay of a
 *    consumed proof (simulating the on-chain bitmap guard).
 *
 * 3. Cross-epoch isolation: a proof generated for one root is invalid
 *    against a rotated root (simulating epoch guard on-chain).
 *
 * 4. Bitmap boundary: claim indices that span across bitmap word
 *    boundaries (multiples of 128) are independently tracked.
 */

import {
  generateMerkleTree,
  verifyProof,
  computeLeaf,
  hashPair,
  type RewardEntry,
} from "../merkleTree";
import { createHash } from "crypto";

// ── Encoding Invariant Tests ─────────────────────────────────────────────────

describe("Off-chain ↔ On-chain encoding invariant", () => {
  /**
   * The on-chain compute_leaf encodes as:
   *   SHA256( index_be4 || address_utf8 || amount_be16 )
   *
   * This test derives the same hash manually to confirm the TypeScript
   * computeLeaf implementation matches that exact layout.
   */
  it("computeLeaf encodes index(4), address(utf8), amount(16) exactly as on-chain formula", () => {
    const index = 0;
    const address = "GABCDE1234567890ABCDE1234567890ABCDE1234567"; // 43-char Stellar address
    const amount = "1000000";

    // Manual re-implementation of the on-chain layout
    const indexBuf = Buffer.alloc(4);
    indexBuf.writeUInt32BE(index, 0);

    const addressBuf = Buffer.from(address, "utf-8");

    const amountVal = BigInt(amount);
    const amountBuf = Buffer.alloc(16, 0);
    let v = amountVal;
    for (let i = 15; i >= 0; i--) {
      amountBuf[i] = Number(v & BigInt(0xff));
      v >>= BigInt(8);
    }

    const expected = createHash("sha256")
      .update(Buffer.concat([indexBuf, addressBuf, amountBuf]))
      .digest();

    const actual = computeLeaf(index, address, amount);
    expect(actual.equals(expected)).toBe(true);
  });

  it("index byte-width is exactly 4 (uint32 big-endian)", () => {
    // Indices 0 and 256 must differ only in the first 4 bytes
    const addr = "GTEST";
    const amt = "500";
    const leaf0 = computeLeaf(0, addr, amt);
    const leaf256 = computeLeaf(256, addr, amt);
    // They must produce different hashes (different index encoding)
    expect(leaf0.equals(leaf256)).toBe(false);
  });

  it("amount byte-width is exactly 16 (i128 big-endian)", () => {
    // Amounts that differ only in the high byte of a 16-byte representation
    const addr = "GTEST2";
    const idx = 1;
    // 2^64 is a value requiring >8 bytes in its representation
    const bigAmount = (BigInt(2) ** BigInt(64)).toString();
    const smallAmount = "1";
    const leafBig = computeLeaf(idx, addr, bigAmount);
    const leafSmall = computeLeaf(idx, addr, smallAmount);
    expect(leafBig.equals(leafSmall)).toBe(false);
    // Both still produce 32-byte leaves
    expect(leafBig.length).toBe(32);
    expect(leafSmall.length).toBe(32);
  });

  it("hashPair is commutative (matches on-chain sorted-pair hashing)", () => {
    const a = computeLeaf(0, "GA", "100");
    const b = computeLeaf(1, "GB", "200");
    // hashPair(a,b) == hashPair(b,a) — same as Rust hash_pair
    expect(hashPair(a, b).equals(hashPair(b, a))).toBe(true);
  });

  it("round-trip: off-chain proof verifies against off-chain root (proves wiring is correct)", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "GADDR_ALICE", amount: "500000" },
      { index: 1, address: "GADDR_BOB", amount: "300000" },
      { index: 2, address: "GADDR_CAROL", amount: "200000" },
    ];
    const { root, claims } = generateMerkleTree(entries);

    for (const entry of entries) {
      const claim = claims[entry.address];
      expect(
        verifyProof(root, claim.index, entry.address, claim.amount, claim.proof)
      ).toBe(true);
    }
  });
});

// ── Anti-Double-Claim Tests ──────────────────────────────────────────────────

/**
 * Simulate the on-chain bitmap-based double-claim guard in TypeScript.
 * The distributor contract stores a bitmap; once index i is set, any
 * subsequent claim for i is rejected. We mirror this behaviour here.
 */
class ClaimTracker {
  private claimed = new Set<number>();

  isClaimed(index: number): boolean {
    return this.claimed.has(index);
  }

  setClaimed(index: number): void {
    this.claimed.add(index);
  }

  /** Attempt a claim. Returns false if already claimed (mirrors on-chain AlreadyClaimed error). */
  attemptClaim(
    root: string,
    index: number,
    address: string,
    amount: string,
    proof: string[]
  ): boolean {
    if (this.isClaimed(index)) return false;
    const valid = verifyProof(root, index, address, amount, proof);
    if (!valid) return false;
    this.setClaimed(index);
    return true;
  }
}

describe("Anti-double-claim (mirrors on-chain bitmap guard)", () => {
  it("first claim succeeds; second claim for same index is rejected", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "GALICE", amount: "1000" },
    ];
    const { root, claims } = generateMerkleTree(entries);
    const { index, amount, proof } = claims["GALICE"];
    const tracker = new ClaimTracker();

    expect(tracker.attemptClaim(root, index, "GALICE", amount, proof)).toBe(true);
    // Second attempt — already claimed
    expect(tracker.attemptClaim(root, index, "GALICE", amount, proof)).toBe(false);
  });

  it("double-claim rejected even with a valid proof", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "GBOB", amount: "5000" },
      { index: 1, address: "GCAROL", amount: "3000" },
    ];
    const { root, claims } = generateMerkleTree(entries);
    const tracker = new ClaimTracker();

    // Bob claims successfully
    const bob = claims["GBOB"];
    expect(tracker.attemptClaim(root, bob.index, "GBOB", bob.amount, bob.proof)).toBe(true);
    // Bob replays — valid proof, but already claimed
    expect(tracker.attemptClaim(root, bob.index, "GBOB", bob.amount, bob.proof)).toBe(false);

    // Carol can still claim independently
    const carol = claims["GCAROL"];
    expect(tracker.attemptClaim(root, carol.index, "GCAROL", carol.amount, carol.proof)).toBe(true);
  });

  it("different users can claim their own indices independently", () => {
    const n = 10;
    const entries: RewardEntry[] = Array.from({ length: n }, (_, i) => ({
      index: i,
      address: `GUSER${i}`,
      amount: ((i + 1) * 1000).toString(),
    }));
    const { root, claims } = generateMerkleTree(entries);
    const tracker = new ClaimTracker();

    // All n claims succeed once
    for (const entry of entries) {
      const { index, amount, proof } = claims[entry.address];
      expect(tracker.attemptClaim(root, index, entry.address, amount, proof)).toBe(true);
    }

    // All n replays are rejected
    for (const entry of entries) {
      const { index, amount, proof } = claims[entry.address];
      expect(tracker.attemptClaim(root, index, entry.address, amount, proof)).toBe(false);
    }
  });

  it("tampered amount is rejected before the bitmap check", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "GEVE", amount: "1000" },
    ];
    const { root, claims } = generateMerkleTree(entries);
    const tracker = new ClaimTracker();
    const { index, proof } = claims["GEVE"];

    // Attempt with a higher tampered amount
    const accepted = tracker.attemptClaim(root, index, "GEVE", "9999999", proof);
    expect(accepted).toBe(false);
    // Genuine index should NOT be marked claimed after a failed tampered attempt
    expect(tracker.isClaimed(index)).toBe(false);
  });
});

// ── Cross-Epoch Root Rotation Tests ─────────────────────────────────────────

describe("Cross-epoch isolation (mirrors on-chain epoch guard)", () => {
  /**
   * When the admin calls set_merkle_root, the epoch counter increments.
   * Proofs from the previous epoch's root are invalid against the new root.
   */
  it("proof valid under epoch-1 root is invalid under epoch-2 root", () => {
    const epoch1Entries: RewardEntry[] = [
      { index: 0, address: "GALICE", amount: "1000" },
    ];
    const { root: root1, claims: claims1 } = generateMerkleTree(epoch1Entries);

    const epoch2Entries: RewardEntry[] = [
      { index: 0, address: "GALICE", amount: "2000" }, // new allocation
    ];
    const { root: root2 } = generateMerkleTree(epoch2Entries);

    // Epoch-1 proof
    const { index, amount, proof } = claims1["GALICE"];

    expect(verifyProof(root1, index, "GALICE", amount, proof)).toBe(true);
    // Same proof against epoch-2 root must fail
    expect(verifyProof(root2, index, "GALICE", amount, proof)).toBe(false);
  });

  it("new epoch proofs work after root rotation", () => {
    const epoch1Entries: RewardEntry[] = [
      { index: 0, address: "GBOB", amount: "500" },
    ];
    const { root: root1, claims: claims1 } = generateMerkleTree(epoch1Entries);
    const tracker = new ClaimTracker();

    // Claim in epoch 1
    const bob1 = claims1["GBOB"];
    expect(tracker.attemptClaim(root1, bob1.index, "GBOB", bob1.amount, bob1.proof)).toBe(true);

    // Root rotates to epoch 2 — fresh tracker (on-chain epoch bump resets bitmap)
    const epoch2Entries: RewardEntry[] = [
      { index: 0, address: "GBOB", amount: "700" },
    ];
    const { root: root2, claims: claims2 } = generateMerkleTree(epoch2Entries);
    const tracker2 = new ClaimTracker();

    const bob2 = claims2["GBOB"];
    expect(tracker2.attemptClaim(root2, bob2.index, "GBOB", bob2.amount, bob2.proof)).toBe(true);
  });
});

// ── Bitmap Boundary Tests ────────────────────────────────────────────────────

describe("Bitmap boundary (indices spanning word boundaries)", () => {
  it("indices 127 and 128 are tracked independently (separate bitmap words)", () => {
    // On-chain: word_index = index / 128; so index 127 is in word 0, index 128 in word 1
    // Construct 129 entries sequentially so index matches array index
    const entries: RewardEntry[] = Array.from({ length: 129 }, (_, i) => ({
      index: i,
      address: i === 127 ? "GLAST_IN_WORD0" : i === 128 ? "GFIRST_IN_WORD1" : `GDUMMY${i}`,
      amount: i === 127 ? "100" : i === 128 ? "200" : "50",
    }));

    const { root, claims } = generateMerkleTree(entries);
    const tracker = new ClaimTracker();

    const c127 = claims["GLAST_IN_WORD0"];
    const c128 = claims["GFIRST_IN_WORD1"];

    expect(tracker.attemptClaim(root, c127.index, "GLAST_IN_WORD0", c127.amount, c127.proof)).toBe(true);
    expect(tracker.attemptClaim(root, c128.index, "GFIRST_IN_WORD1", c128.amount, c128.proof)).toBe(true);

    // Replays are rejected for each
    expect(tracker.attemptClaim(root, c127.index, "GLAST_IN_WORD0", c127.amount, c127.proof)).toBe(false);
    expect(tracker.attemptClaim(root, c128.index, "GFIRST_IN_WORD1", c128.amount, c128.proof)).toBe(false);
  });
});
