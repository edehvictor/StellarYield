import {
  calculateRewards,
  generateWeeklyDistribution,
  getUserProof,
  type UserRewardInput,
} from "../generateTree";
import { verifyProof } from "../merkleTree";

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
