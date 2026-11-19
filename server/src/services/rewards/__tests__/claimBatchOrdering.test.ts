import {
  normalizeClaimBatch,
  compareClaims,
  claimOrderKey,
  DuplicateClaimError,
  type BatchClaim,
} from "../claimBatchOrdering";

function makeClaim(overrides: Partial<BatchClaim> = {}): BatchClaim {
  return {
    campaignId: "2026-W22",
    account: "GABCDEF",
    asset: "YIELD",
    claimIndex: 0,
    amount: "5000",
    proof: ["a".repeat(64)],
    ...overrides,
  };
}

/** Deterministic pseudo-shuffle (seeded LCG) so failures are reproducible. */
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  let seed = 42;
  for (let i = copy.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const FULL_SET: BatchClaim[] = [
  makeClaim({ campaignId: "2026-W20", account: "GAAA", asset: "USDC", claimIndex: 3, amount: "100", proof: ["b".repeat(64)] }),
  makeClaim({ campaignId: "2026-W20", account: "GAAA", asset: "YIELD", claimIndex: 1, amount: "200", proof: ["c".repeat(64)] }),
  makeClaim({ campaignId: "2026-W20", account: "GZZZ", asset: "USDC", claimIndex: 2, amount: "300", proof: ["d".repeat(64)] }),
  makeClaim({ campaignId: "2026-W22", account: "GAAA", asset: "USDC", claimIndex: 10, amount: "400", proof: ["e".repeat(64)] }),
  makeClaim({ campaignId: "2026-W22", account: "GAAA", asset: "USDC", claimIndex: 2, amount: "500", proof: ["f".repeat(64)] }),
  makeClaim({ campaignId: "2026-W22", account: "GAAA", asset: "YIELD", claimIndex: 0, amount: "600", proof: ["g".repeat(64)] }),
  makeClaim({ campaignId: "2026-W22", account: "GBBB", asset: "YIELD", claimIndex: 4, amount: "700", proof: ["h".repeat(64)] }),
  makeClaim({ campaignId: "2026-W21", account: "GZZZ", asset: "USDC", claimIndex: 1, amount: "800", proof: ["i".repeat(64)] }),
];

describe("claimBatchOrdering (server)", () => {
  describe("normalizeClaimBatch", () => {
    it("orders by campaign, account, asset, then numeric claim index", () => {
      const ordered = normalizeClaimBatch(FULL_SET);
      const keys = ordered.map((c) => claimOrderKey(c));
      // claimIndex ordering is numeric, not lexicographic: index 10 after index 2.
      expect(keys).toEqual([
        "2026-W20\u0000GAAA\u0000USDC\u00003",
        "2026-W20\u0000GAAA\u0000YIELD\u00001",
        "2026-W20\u0000GZZZ\u0000USDC\u00002",
        "2026-W21\u0000GZZZ\u0000USDC\u00001",
        "2026-W22\u0000GAAA\u0000USDC\u00002",
        "2026-W22\u0000GAAA\u0000USDC\u000010",
        "2026-W22\u0000GAAA\u0000YIELD\u00000",
        "2026-W22\u0000GBBB\u0000YIELD\u00004",
      ]);
    });

    it("produces identical ordered batches for shuffled inputs", () => {
      for (let round = 0; round < 20; round++) {
        const shuffled = shuffle(FULL_SET);
        expect(normalizeClaimBatch(shuffled)).toEqual(normalizeClaimBatch(FULL_SET));
      }
    });

    it("does not mutate the caller's array", () => {
      const input = shuffle(FULL_SET);
      const before = [...input];
      normalizeClaimBatch(input);
      expect(input).toEqual(before);
    });

    it("rejects a duplicate claim with a typed error", () => {
      const batch = [makeClaim(), makeClaim()];
      try {
        normalizeClaimBatch(batch);
        throw new Error("expected DuplicateClaimError");
      } catch (error) {
        expect(error).toBeInstanceOf(DuplicateClaimError);
        const typed = error as DuplicateClaimError;
        expect(typed.code).toBe("duplicate_claim");
        expect(typed.duplicateKey).toBe("2026-W22\u0000GABCDEF\u0000YIELD\u00000");
        expect(typed.message).toMatch(/duplicate claim/i);
      }
    });

    it("rejects duplicates even when the payload differs (amount/proof)", () => {
      const batch = [
        makeClaim({ amount: "100", proof: ["a".repeat(64)] }),
        makeClaim({ amount: "999", proof: ["b".repeat(64)] }),
      ];
      expect(() => normalizeClaimBatch(batch)).toThrow(DuplicateClaimError);
    });

    it("mixed batch: rejects the duplicate and reports the exact key", () => {
      const mixed = shuffle([
        makeClaim({ account: "GZZZ", claimIndex: 2 }),
        makeClaim({ account: "GAAA", claimIndex: 1 }),
        makeClaim({ account: "GAAA", claimIndex: 1 }), // duplicate
      ]);
      expect(() => normalizeClaimBatch(mixed)).toThrow(DuplicateClaimError);
      try {
        normalizeClaimBatch(mixed);
      } catch (error) {
        expect((error as DuplicateClaimError).duplicateKey).toBe(
          "2026-W22\u0000GAAA\u0000YIELD\u00001",
        );
      }
    });
  });

  describe("compareClaims / claimOrderKey", () => {
    it("compares by claimIndex numerically", () => {
      expect(compareClaims(makeClaim({ claimIndex: 2 }), makeClaim({ claimIndex: 10 }))).toBeLessThan(0);
      expect(compareClaims(makeClaim({ claimIndex: 10 }), makeClaim({ claimIndex: 2 }))).toBeGreaterThan(0);
    });

    it("returns 0 only for duplicate keys", () => {
      expect(compareClaims(makeClaim(), makeClaim())).toBe(0);
      expect(compareClaims(makeClaim({ claimIndex: 1 }), makeClaim({ claimIndex: 2 }))).not.toBe(0);
    });
  });
});
