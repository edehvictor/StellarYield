import {
  calculateRewards,
  generateWeeklyDistribution,
  generateWeeklyDistributionWithManifest,
  getUserProof,
  buildArtifactManifest,
  validateArtifactManifest,
  type UserRewardInput,
  type RewardArtifactManifest,
} from "../generateTree";
import { generateMerkleTree, verifyProof, type RewardEntry } from "../merkleTree";

// ── calculateRewards ────────────────────────────────────────────────────

describe("calculateRewards", () => {
  it("distributes proportionally based on shares", () => {
    const users: UserRewardInput[] = [
      { address: "G1", shares: "500", totalShares: "1000" },
      { address: "G2", shares: "300", totalShares: "1000" },
      { address: "G3", shares: "200", totalShares: "1000" },
    ];
    const entries = calculateRewards(users, "10000");
    expect(entries).toHaveLength(3);
    expect(entries[0].amount).toBe("5000");
    expect(entries[1].amount).toBe("3000");
    expect(entries[2].amount).toBe("2000");
  });

  it("assigns sequential indices", () => {
    const users: UserRewardInput[] = [
      { address: "G1", shares: "500", totalShares: "1000" },
      { address: "G2", shares: "500", totalShares: "1000" },
    ];
    const entries = calculateRewards(users, "10000");
    expect(entries[0].index).toBe(0);
    expect(entries[1].index).toBe(1);
  });

  it("skips users with zero shares", () => {
    const users: UserRewardInput[] = [
      { address: "G1", shares: "0", totalShares: "1000" },
      { address: "G2", shares: "500", totalShares: "1000" },
    ];
    const entries = calculateRewards(users, "10000");
    expect(entries).toHaveLength(1);
    expect(entries[0].address).toBe("G2");
  });

  it("skips users with negative shares", () => {
    const users: UserRewardInput[] = [
      { address: "G1", shares: "-100", totalShares: "1000" },
      { address: "G2", shares: "500", totalShares: "1000" },
    ];
    const entries = calculateRewards(users, "10000");
    expect(entries).toHaveLength(1);
  });

  it("returns empty for no users", () => {
    const entries = calculateRewards([], "10000");
    expect(entries).toHaveLength(0);
  });

  it("handles very large amounts", () => {
    const users: UserRewardInput[] = [
      {
        address: "G1",
        shares: "1000000000000",
        totalShares: "2000000000000",
      },
    ];
    const entries = calculateRewards(users, "5000000000000");
    expect(entries[0].amount).toBe("2500000000000");
  });
});

// ── generateWeeklyDistribution ──────────────────────────────────────────

describe("generateWeeklyDistribution", () => {
  it("produces a valid distribution with root and claims", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "500", totalShares: "1000" },
      { address: "GADDR2", shares: "300", totalShares: "1000" },
      { address: "GADDR3", shares: "200", totalShares: "1000" },
    ];
    const result = generateWeeklyDistribution(users, "10000");

    expect(result.root).toHaveLength(64);
    expect(Object.keys(result.claims)).toHaveLength(3);
    expect(result.claims["GADDR1"].amount).toBe("5000");
    expect(result.claims["GADDR2"].amount).toBe("3000");
    expect(result.claims["GADDR3"].amount).toBe("2000");
  });

  it("produces verifiable proofs for all users", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "500", totalShares: "1000" },
      { address: "GADDR2", shares: "300", totalShares: "1000" },
      { address: "GADDR3", shares: "200", totalShares: "1000" },
    ];
    const result = generateWeeklyDistribution(users, "10000");

    for (const [address, claim] of Object.entries(result.claims)) {
      const valid = verifyProof(
        result.root,
        claim.index,
        address,
        claim.amount,
        claim.proof,
      );
      expect(valid).toBe(true);
    }
  });

  it("returns empty distribution when all shares are zero", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "0", totalShares: "1000" },
    ];
    const result = generateWeeklyDistribution(users, "10000");
    expect(result.root).toBe("0".repeat(64));
    expect(Object.keys(result.claims)).toHaveLength(0);
  });
});

// ── getUserProof ────────────────────────────────────────────────────────

describe("getUserProof", () => {
  it("returns proof for existing user", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "500", totalShares: "1000" },
      { address: "GADDR2", shares: "500", totalShares: "1000" },
    ];
    const dist = generateWeeklyDistribution(users, "10000");
    const proof = getUserProof("GADDR1", dist);

    expect(proof).not.toBeNull();
    expect(proof!.index).toBe(0);
    expect(proof!.amount).toBe("5000");
    expect(proof!.proof).toBeInstanceOf(Array);
  });

  it("returns null for non-existent user", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "500", totalShares: "1000" },
    ];
    const dist = generateWeeklyDistribution(users, "10000");
    const proof = getUserProof("GNONEXISTENT", dist);

    expect(proof).toBeNull();
  });
});

// ── buildArtifactManifest (#997) ────────────────────────────────────────

describe("buildArtifactManifest", () => {
  const entries: RewardEntry[] = [
    { index: 0, address: "GADDR1", amount: "5000" },
    { index: 1, address: "GADDR2", amount: "3000" },
    { index: 2, address: "GADDR3", amount: "2000" },
  ];
  const result = generateMerkleTree(entries);
  const fixedNow = new Date("2026-07-01T12:00:00.000Z");

  it("manifest includes the correct merkleRoot", () => {
    const manifest = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: "1.0.0",
      sourceCommit: "abc1234",
    });
    expect(manifest.merkleRoot).toBe(result.root);
  });

  it("manifest includes the correct campaignId", () => {
    const manifest = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: "1.0.0",
      sourceCommit: "abc1234",
    });
    expect(manifest.campaignId).toBe("2026-W27");
  });

  it("manifest recipientCount equals entries length", () => {
    const manifest = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: null,
      sourceCommit: null,
    });
    expect(manifest.recipientCount).toBe(3);
  });

  it("manifest totalAmount is the sum of all entry amounts", () => {
    const manifest = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: null,
      sourceCommit: null,
    });
    expect(manifest.totalAmount).toBe("10000");
  });

  it("manifest generatedAt is the ISO timestamp of now", () => {
    const manifest = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: null,
      sourceCommit: null,
    });
    expect(manifest.generatedAt).toBe("2026-07-01T12:00:00.000Z");
  });

  it("manifest inputHash is a 64-char hex string", () => {
    const manifest = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: null,
      sourceCommit: null,
    });
    expect(manifest.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("manifest inputHash changes when entries change", () => {
    const manifest1 = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: null,
      sourceCommit: null,
    });
    const differentEntries: RewardEntry[] = [
      { index: 0, address: "GADDR1", amount: "9000" },
    ];
    const differentResult = generateMerkleTree(differentEntries);
    const manifest2 = buildArtifactManifest("2026-W27", differentEntries, differentResult, {
      now: fixedNow,
      toolVersion: null,
      sourceCommit: null,
    });
    expect(manifest1.inputHash).not.toBe(manifest2.inputHash);
  });

  it("manifest toolVersion and sourceCommit are passed through from options", () => {
    const manifest = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: "2.3.1",
      sourceCommit: "deadbeef",
    });
    expect(manifest.toolVersion).toBe("2.3.1");
    expect(manifest.sourceCommit).toBe("deadbeef");
  });

  it("manifest toolVersion and sourceCommit are null when explicitly set to null", () => {
    const manifest = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: null,
      sourceCommit: null,
    });
    expect(manifest.toolVersion).toBeNull();
    expect(manifest.sourceCommit).toBeNull();
  });

  it("manifest is deterministic: same inputs produce the same manifest", () => {
    const opts = { now: fixedNow, toolVersion: "1.0.0", sourceCommit: "abc" };
    const m1 = buildArtifactManifest("2026-W27", entries, result, opts);
    const m2 = buildArtifactManifest("2026-W27", entries, result, opts);
    expect(m1).toEqual(m2);
  });
});

// ── validateArtifactManifest (#997) ─────────────────────────────────────

describe("validateArtifactManifest", () => {
  const entries: RewardEntry[] = [
    { index: 0, address: "GADDR1", amount: "5000" },
    { index: 1, address: "GADDR2", amount: "3000" },
  ];
  const result = generateMerkleTree(entries);
  const fixedNow = new Date("2026-07-01T12:00:00.000Z");

  function makeManifest(overrides: Partial<RewardArtifactManifest> = {}): RewardArtifactManifest {
    const base = buildArtifactManifest("2026-W27", entries, result, {
      now: fixedNow,
      toolVersion: "1.0.0",
      sourceCommit: "abc1234",
    });
    return { ...base, ...overrides };
  }

  it("returns null for a valid manifest", () => {
    const manifest = makeManifest();
    expect(validateArtifactManifest(manifest, entries, result)).toBeNull();
  });

  it("returns an error string when merkleRoot mismatches", () => {
    const manifest = makeManifest({ merkleRoot: "f".repeat(64) });
    const error = validateArtifactManifest(manifest, entries, result);
    expect(error).not.toBeNull();
    expect(error).toMatch(/merkleRoot mismatch/i);
  });

  it("returns an error string when inputHash mismatches", () => {
    const manifest = makeManifest({ inputHash: "0".repeat(64) });
    const error = validateArtifactManifest(manifest, entries, result);
    expect(error).not.toBeNull();
    expect(error).toMatch(/inputHash mismatch/i);
  });

  it("returns an error string when recipientCount mismatches", () => {
    const manifest = makeManifest({ recipientCount: 99 });
    const error = validateArtifactManifest(manifest, entries, result);
    expect(error).not.toBeNull();
    expect(error).toMatch(/recipientCount mismatch/i);
  });

  it("returns an error string when totalAmount mismatches", () => {
    const manifest = makeManifest({ totalAmount: "1" });
    const error = validateArtifactManifest(manifest, entries, result);
    expect(error).not.toBeNull();
    expect(error).toMatch(/totalAmount mismatch/i);
  });
});

// ── generateWeeklyDistributionWithManifest (#997) ───────────────────────

describe("generateWeeklyDistributionWithManifest", () => {
  const users: UserRewardInput[] = [
    { address: "GADDR1", shares: "500", totalShares: "1000" },
    { address: "GADDR2", shares: "500", totalShares: "1000" },
  ];
  const fixedNow = new Date("2026-07-01T12:00:00.000Z");

  it("returns result and manifest with matching root", () => {
    const { result, manifest } = generateWeeklyDistributionWithManifest(
      "2026-W27",
      users,
      "10000",
      { now: fixedNow, toolVersion: null, sourceCommit: null },
    );
    expect(manifest.merkleRoot).toBe(result.root);
  });

  it("manifest validates successfully against its own result", () => {
    const entries = [
      { index: 0, address: "GADDR1", amount: "5000" },
      { index: 1, address: "GADDR2", amount: "5000" },
    ];
    const { result, manifest } = generateWeeklyDistributionWithManifest(
      "2026-W27",
      users,
      "10000",
      { now: fixedNow, toolVersion: null, sourceCommit: null },
    );
    expect(validateArtifactManifest(manifest, entries, result)).toBeNull();
  });

  it("manifest has the correct campaignId", () => {
    const { manifest } = generateWeeklyDistributionWithManifest(
      "2026-W27",
      users,
      "10000",
      { now: fixedNow, toolVersion: null, sourceCommit: null },
    );
    expect(manifest.campaignId).toBe("2026-W27");
  });

  it("manifest totalAmount equals totalWeeklyReward for equal shares", () => {
    const { manifest } = generateWeeklyDistributionWithManifest(
      "2026-W27",
      users,
      "10000",
      { now: fixedNow, toolVersion: null, sourceCommit: null },
    );
    // 2 users with equal shares get 5000 each → total 10000
    expect(manifest.totalAmount).toBe("10000");
  });
});
