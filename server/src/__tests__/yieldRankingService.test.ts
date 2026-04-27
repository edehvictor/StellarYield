jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn(),
}));

import {
  calculateRankings,
  getOpportunityByRank,
  DEFAULT_RANKING_WEIGHTS,
  scoreApy,
  scoreTvl,
  scoreLiquidity,
  scoreMaturity,
  scoreVolatility,
  validateWeights,
  clearRankingCache,
} from "../services/yieldRankingService";

import { getYieldData } from "../services/yieldService";

const mockYields = [
  {
    protocolName: "Blend",
    apy: 6.75,
    tvl: 12_500_000,
    riskScore: 8.5,
    source: "stellar://blend",
    fetchedAt: "2026-03-25T10:00:00.000Z",
    attribution: {
      baseYield: 5.4,
      incentives: 1.35,
      compounding: 0.34,
      tacticalRotation: 0.34,
    },
  },
  {
    protocolName: "Soroswap",
    apy: 11.2,
    tvl: 4_850_000,
    riskScore: 7.2,
    source: "stellar://soroswap",
    fetchedAt: "2026-03-25T10:00:00.000Z",
    attribution: {
      baseYield: 8.96,
      incentives: 2.24,
      compounding: 0.56,
      tacticalRotation: 0.56,
    },
  },
];

describe("yieldRankingService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearRankingCache();
  });

  describe("scoreApy", () => {
    it("returns normalized score between 0 and 100", () => {
      const score = scoreApy(10, 5, 15);
      expect(score).toBe(50);
    });

    it("returns 0 for minimum APY", () => {
      const score = scoreApy(5, 5, 15);
      expect(score).toBe(0);
    });

    it("returns 100 for maximum APY", () => {
      const score = scoreApy(15, 5, 15);
      expect(score).toBe(100);
    });
  });

  describe("scoreTvl", () => {
    it("returns normalized score for TVL", () => {
      const score = scoreTvl(1_000_000, 100_000, 10_000_000);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe("scoreLiquidity", () => {
    it("returns same as scoreTvl", () => {
      const tvl = 5_000_000;
      const min = 1_000_000;
      const max = 10_000_000;
      expect(scoreLiquidity(tvl, min, max)).toBe(scoreTvl(tvl, min, max));
    });
  });

  describe("scoreMaturity", () => {
    it("converts risk score to 0-100 scale", () => {
      expect(scoreMaturity(8)).toBe(80);
      expect(scoreMaturity(5)).toBe(50);
    });
  });

  describe("scoreVolatility", () => {
    it("inverts risk score for volatility", () => {
      expect(scoreVolatility(2)).toBe(80);
      expect(scoreVolatility(8)).toBe(20);
    });
  });

  describe("validateWeights", () => {
    it("returns default weights for invalid total", () => {
      const result = validateWeights({ apy: 0.3, tvl: 0.3 });
      expect(result).toEqual(DEFAULT_RANKING_WEIGHTS);
    });

    it("accepts valid weights", () => {
      const result = validateWeights({
        apy: 0.4,
        tvl: 0.3,
        liquidity: 0.1,
        protocolMaturity: 0.1,
        volatility: 0.1,
      });
      expect(result.apy).toBe(0.4);
      expect(result.tvl).toBe(0.3);
    });
  });

  describe("calculateRankings", () => {
    it("ranks opportunities correctly", async () => {
      (getYieldData as jest.Mock).mockResolvedValue(mockYields);

      const result = await calculateRankings();

      expect(result.opportunities).toHaveLength(2);
      expect(result.opportunities[0].rank).toBe(1);
      expect(result.opportunities[1].rank).toBe(2);
    });

    it("handles empty yield data", async () => {
      (getYieldData as jest.Mock).mockResolvedValue([]);

      const result = await calculateRankings();

      expect(result.opportunities).toHaveLength(0);
      expect(result.warnings).toContain(
        "No yield data available from upstream providers.",
      );
    });

    it("filters out malformed data", async () => {
      (getYieldData as jest.Mock).mockResolvedValue([
        ...mockYields,
        { protocolName: "BadProtocol", apy: -5, tvl: 1000, riskScore: 5 },
      ]);

      const result = await calculateRankings();

      expect(result.opportunities).toHaveLength(2);
      expect(result.warnings).toContainEqual(
        expect.stringContaining("Invalid negative values"),
      );
    });

    it("applies custom weights", async () => {
      (getYieldData as jest.Mock).mockResolvedValue(mockYields);

      const result = await calculateRankings({
        apy: 0.5,
        tvl: 0.2,
        liquidity: 0.1,
        protocolMaturity: 0.1,
        volatility: 0.1,
      });

      expect(result.weights.apy).toBe(0.5);
    });

    it("handles tie-breaking by equal scores", async () => {
      (getYieldData as jest.Mock).mockResolvedValue([
        { ...mockYields[0], apy: 10, tvl: 10_000_000 },
        { ...mockYields[1], apy: 10, tvl: 10_000_000 },
      ]);

      const result = await calculateRankings();

      expect(result.opportunities).toHaveLength(2);
    });
  });

  describe("getOpportunityByRank", () => {
    it("returns correct opportunity for rank", async () => {
      (getYieldData as jest.Mock).mockResolvedValue(mockYields);

      const opportunity = await getOpportunityByRank(1);

      expect(opportunity?.rank).toBe(1);
      expect(opportunity?.protocolName).toBeDefined();
    });

    it("returns null for invalid rank", async () => {
      (getYieldData as jest.Mock).mockResolvedValue(mockYields);

      const opportunity = await getOpportunityByRank(99);

      expect(opportunity).toBeNull();
    });
  });
});