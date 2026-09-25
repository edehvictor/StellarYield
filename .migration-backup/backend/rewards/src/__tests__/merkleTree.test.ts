import {
  generateMerkleTree,
  verifyProof,
  computeLeaf,
  hashPair,
  previewRewardClaim,
  findProofShapeError,
  type RewardEntry,
  type RewardCampaignInfo,
} from "../merkleTree";

// ── computeLeaf ─────────────────────────────────────────────────────────

describe("computeLeaf", () => {
  it("produces a 32-byte buffer", () => {
    const leaf = computeLeaf(0, "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567", "1000");
    expect(leaf.length).toBe(32);
  });

  it("produces different hashes for different indices", () => {
    const a = computeLeaf(0, "GABCDEF", "1000");
    const b = computeLeaf(1, "GABCDEF", "1000");
    expect(a.equals(b)).toBe(false);
  });

  it("produces different hashes for different addresses", () => {
    const a = computeLeaf(0, "GABCDEF", "1000");
    const b = computeLeaf(0, "GXYZ123", "1000");
    expect(a.equals(b)).toBe(false);
  });

  it("produces different hashes for different amounts", () => {
    const a = computeLeaf(0, "GABCDEF", "1000");
    const b = computeLeaf(0, "GABCDEF", "2000");
    expect(a.equals(b)).toBe(false);
  });

  it("is deterministic", () => {
    const a = computeLeaf(5, "GABCDEF", "999");
    const b = computeLeaf(5, "GABCDEF", "999");
    expect(a.equals(b)).toBe(true);
  });
});

// ── hashPair ────────────────────────────────────────────────────────────

describe("hashPair", () => {
  it("produces a 32-byte buffer", () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    const result = hashPair(a, b);
    expect(result.length).toBe(32);
  });

  it("is commutative (sorted-pair hashing)", () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    expect(hashPair(a, b).equals(hashPair(b, a))).toBe(true);
  });

  it("produces different hashes for different inputs", () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    const c = Buffer.alloc(32, 3);
    expect(hashPair(a, b).equals(hashPair(a, c))).toBe(false);
  });
});

// ── generateMerkleTree ──────────────────────────────────────────────────

describe("generateMerkleTree", () => {
  it("returns a zero root for empty entries", () => {
    const result = generateMerkleTree([]);
    expect(result.root).toBe("0".repeat(64));
    expect(Object.keys(result.claims)).toHaveLength(0);
  });

  it("returns a valid root for a single entry", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "GABCDEF", amount: "1000" },
    ];
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);
    expect(result.claims["GABCDEF"]).toBeDefined();
    expect(result.claims["GABCDEF"].proof).toHaveLength(0);
  });

  it("returns valid proofs for two entries", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "GADDR1", amount: "500" },
      { index: 1, address: "GADDR2", amount: "300" },
    ];
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);

    // Each claim should have exactly one proof element (the sibling leaf)
    expect(result.claims["GADDR1"].proof).toHaveLength(1);
    expect(result.claims["GADDR2"].proof).toHaveLength(1);
  });

  it("returns valid proofs for four entries", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "G1", amount: "100" },
      { index: 1, address: "G2", amount: "200" },
      { index: 2, address: "G3", amount: "300" },
      { index: 3, address: "G4", amount: "400" },
    ];
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);

    // 4-leaf tree has depth 2, so each proof should have 2 elements
    expect(result.claims["G1"].proof).toHaveLength(2);
    expect(result.claims["G2"].proof).toHaveLength(2);
    expect(result.claims["G3"].proof).toHaveLength(2);
    expect(result.claims["G4"].proof).toHaveLength(2);
  });

  it("handles odd number of entries (3 leaves)", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "GA", amount: "100" },
      { index: 1, address: "GB", amount: "200" },
      { index: 2, address: "GC", amount: "300" },
    ];
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);
    expect(Object.keys(result.claims)).toHaveLength(3);
  });

  it("handles large set of entries (100 users)", () => {
    const entries: RewardEntry[] = Array.from({ length: 100 }, (_, i) => ({
      index: i,
      address: `GADDR${i.toString().padStart(3, "0")}`,
      amount: ((i + 1) * 1000).toString(),
    }));
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);
    expect(Object.keys(result.claims)).toHaveLength(100);
  });
});

// ── verifyProof ─────────────────────────────────────────────────────────

describe("verifyProof", () => {
  it("verifies a valid single-leaf proof", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "GABCDEF", amount: "1000" },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["GABCDEF"];
    const valid = verifyProof(
      result.root,
      claim.index,
      "GABCDEF",
      claim.amount,
      claim.proof,
    );
    expect(valid).toBe(true);
  });

  it("verifies valid proofs for all entries in a multi-leaf tree", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "G1", amount: "100" },
      { index: 1, address: "G2", amount: "200" },
      { index: 2, address: "G3", amount: "300" },
      { index: 3, address: "G4", amount: "400" },
    ];
    const result = generateMerkleTree(entries);

    for (const entry of entries) {
      const claim = result.claims[entry.address];
      const valid = verifyProof(
        result.root,
        claim.index,
        entry.address,
        claim.amount,
        claim.proof,
      );
      expect(valid).toBe(true);
    }
  });

  it("rejects a proof with wrong amount", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "G1", amount: "100" },
      { index: 1, address: "G2", amount: "200" },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["G1"];
    const valid = verifyProof(
      result.root,
      claim.index,
      "G1",
      "999",
      claim.proof,
    );
    expect(valid).toBe(false);
  });

  it("rejects a proof with wrong address", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "G1", amount: "100" },
      { index: 1, address: "G2", amount: "200" },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["G1"];
    const valid = verifyProof(
      result.root,
      claim.index,
      "GWRONG",
      claim.amount,
      claim.proof,
    );
    expect(valid).toBe(false);
  });

  it("rejects a proof with wrong index", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "G1", amount: "100" },
      { index: 1, address: "G2", amount: "200" },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["G1"];
    const valid = verifyProof(
      result.root,
      99,
      "G1",
      claim.amount,
      claim.proof,
    );
    expect(valid).toBe(false);
  });

  it("rejects a proof against a wrong root", () => {
    const entries: RewardEntry[] = [
      { index: 0, address: "G1", amount: "100" },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["G1"];
    const valid = verifyProof(
      "f".repeat(64),
      claim.index,
      "G1",
      claim.amount,
      claim.proof,
    );
    expect(valid).toBe(false);
  });

  it("verifies proofs for 100 users", () => {
    const entries: RewardEntry[] = Array.from({ length: 100 }, (_, i) => ({
      index: i,
      address: `GADDR${i.toString().padStart(3, "0")}`,
      amount: ((i + 1) * 1000).toString(),
    }));
    const result = generateMerkleTree(entries);

    for (const entry of entries) {
      const claim = result.claims[entry.address];
      const valid = verifyProof(
        result.root,
        claim.index,
        entry.address,
        claim.amount,
        claim.proof,
      );
      expect(valid).toBe(true);
    }
  });
});

// ── findProofShapeError (#964) ─────────────────────────────────────────────

describe("findProofShapeError", () => {
  const validHash = "a".repeat(64);
  const otherValidHash = "b".repeat(64);

  it("returns null for a well-formed proof", () => {
    expect(findProofShapeError([validHash, otherValidHash])).toBeNull();
  });

  it("returns null for an empty proof", () => {
    expect(findProofShapeError([])).toBeNull();
  });

  it("flags a non-hex element as malformed", () => {
    const error = findProofShapeError(["not-a-hex-string".padEnd(64, "z")]);
    expect(error).toMatch(/malformed/i);
  });

  it("flags an element with the wrong length as malformed", () => {
    const error = findProofShapeError(["ab".repeat(10)]);
    expect(error).toMatch(/malformed/i);
  });

  it("flags a duplicate path element", () => {
    const error = findProofShapeError([validHash, otherValidHash, validHash]);
    expect(error).toMatch(/duplicate/i);
  });

  it("flags a proof deeper than MAX_PROOF_DEPTH", () => {
    const deepProof = Array.from({ length: 21 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const error = findProofShapeError(deepProof);
    expect(error).toMatch(/exceeds/i);
  });
});

// ── previewRewardClaim (#964) ──────────────────────────────────────────────

describe("previewRewardClaim", () => {
  const entries: RewardEntry[] = [
    { index: 0, address: "GCLAIMANT1", amount: "1000" },
    { index: 1, address: "GCLAIMANT2", amount: "2000" },
  ];
  const tree = generateMerkleTree(entries);
  const currentCampaign: RewardCampaignInfo = {
    campaignId: "2026-W22",
    merkleRoot: tree.root,
  };
  const claim = tree.claims["GCLAIMANT1"];

  it("marks a correct claim as valid", () => {
    const result = previewRewardClaim(
      {
        campaignId: "2026-W22",
        merkleRoot: tree.root,
        index: claim.index,
        address: "GCLAIMANT1",
        amount: claim.amount,
        proof: claim.proof,
      },
      currentCampaign,
    );
    expect(result.state).toBe("valid");
    expect(result.errorCode).toBeUndefined();
  });

  it("rejects a mismatched campaign ID", () => {
    const result = previewRewardClaim(
      {
        campaignId: "2026-W21",
        merkleRoot: tree.root,
        index: claim.index,
        address: "GCLAIMANT1",
        amount: claim.amount,
        proof: claim.proof,
      },
      currentCampaign,
    );
    expect(result.state).toBe("invalid");
    expect(result.errorCode).toBe("campaign_id_mismatch");
  });

  it("rejects a malformed proof path", () => {
    const result = previewRewardClaim(
      {
        campaignId: "2026-W22",
        merkleRoot: tree.root,
        index: claim.index,
        address: "GCLAIMANT1",
        amount: claim.amount,
        proof: ["not-valid-hex"],
      },
      currentCampaign,
    );
    expect(result.state).toBe("invalid");
    expect(result.errorCode).toBe("malformed_proof");
  });

  it("rejects a duplicate proof path element", () => {
    const duplicated = claim.proof.length > 0 ? [claim.proof[0], claim.proof[0]] : ["a".repeat(64), "a".repeat(64)];
    const result = previewRewardClaim(
      {
        campaignId: "2026-W22",
        merkleRoot: tree.root,
        index: claim.index,
        address: "GCLAIMANT1",
        amount: claim.amount,
        proof: duplicated,
      },
      currentCampaign,
    );
    expect(result.state).toBe("invalid");
    expect(result.errorCode).toBe("malformed_proof");
  });

  it("marks a claim with a drifted root as stale, not invalid", () => {
    const result = previewRewardClaim(
      {
        campaignId: "2026-W22",
        merkleRoot: "f".repeat(64),
        index: claim.index,
        address: "GCLAIMANT1",
        amount: claim.amount,
        proof: claim.proof,
      },
      currentCampaign,
    );
    expect(result.state).toBe("stale");
    expect(result.errorCode).toBe("root_mismatch");
  });

  it("rejects a well-formed proof that fails cryptographic verification", () => {
    const result = previewRewardClaim(
      {
        campaignId: "2026-W22",
        merkleRoot: tree.root,
        index: claim.index,
        address: "GCLAIMANT1",
        amount: "999999", // wrong amount — proof was generated for a different leaf
        proof: claim.proof,
      },
      currentCampaign,
    );
    expect(result.state).toBe("invalid");
    expect(result.errorCode).toBe("proof_verification_failed");
  });
});
