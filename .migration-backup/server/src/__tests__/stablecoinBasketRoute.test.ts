import request from "supertest";
import { createApp } from "../app";
import { getBasketRebalancePreview } from "../services/stablecoinBasketPreview";

jest.mock("../services/stablecoinBasketPreview", () => {
  const actual = jest.requireActual("../services/stablecoinBasketPreview");
  return {
    ...actual,
    getBasketRebalancePreview: jest.fn(),
  };
});

const mockGetPreview = getBasketRebalancePreview as jest.MockedFunction<
  typeof getBasketRebalancePreview
>;

const CONTRACT_ID = "CBASKET000000000000000000000000000000000000000000000000";

describe("Stablecoin basket rebalance preview routes (#1170)", () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/strategies/stablecoin-basket/:contractId/rebalance-preview", () => {
    it("returns the preview payload", async () => {
      mockGetPreview.mockResolvedValue({
        contractId: CONTRACT_ID,
        totalDeposited: "1000000",
        legs: [
          {
            tokenContractId: "CTOKENA",
            currentWeightBps: 7000,
            targetWeightBps: 6000,
            driftBps: 1000,
            deltaAmount: "-100000",
            isEstimated: false,
          },
        ],
        rebalanceNeeded: true,
        source: "onchain",
        warnings: [],
      });

      const res = await request(app).get(
        `/api/strategies/stablecoin-basket/${CONTRACT_ID}/rebalance-preview`
      );

      expect(res.status).toBe(200);
      expect(res.body.rebalanceNeeded).toBe(true);
      expect(res.body.legs).toHaveLength(1);
      expect(mockGetPreview).toHaveBeenCalledWith(CONTRACT_ID);
    });

    it("still returns 200 with a safe fallback when data is unavailable", async () => {
      mockGetPreview.mockResolvedValue({
        contractId: CONTRACT_ID,
        totalDeposited: "0",
        legs: [],
        rebalanceNeeded: false,
        source: "unavailable",
        warnings: ["Basket data is currently unavailable; showing no preview."],
      });

      const res = await request(app).get(
        `/api/strategies/stablecoin-basket/${CONTRACT_ID}/rebalance-preview`
      );

      expect(res.status).toBe(200);
      expect(res.body.source).toBe("unavailable");
      expect(res.body.legs).toEqual([]);
    });
  });

  describe("POST /api/strategies/stablecoin-basket/:contractId/rebalance-preview/validate", () => {
    it("returns valid:true when weights sum to exactly 10000 bps", async () => {
      const res = await request(app)
        .post(`/api/strategies/stablecoin-basket/${CONTRACT_ID}/rebalance-preview/validate`)
        .send({ targetWeights: [{ token: "A", weightBps: 6000 }, { token: "B", weightBps: 4000 }] });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    it("returns 400 with details when weights sum below 10000 bps", async () => {
      const res = await request(app)
        .post(`/api/strategies/stablecoin-basket/${CONTRACT_ID}/rebalance-preview/validate`)
        .send({ targetWeights: [{ token: "A", weightBps: 5000 }, { token: "B", weightBps: 4000 }] });

      expect(res.status).toBe(400);
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(res.body.details.length).toBeGreaterThan(0);
    });

    it("returns 400 with details when weights sum above 10000 bps", async () => {
      const res = await request(app)
        .post(`/api/strategies/stablecoin-basket/${CONTRACT_ID}/rebalance-preview/validate`)
        .send({ targetWeights: [{ token: "A", weightBps: 6000 }, { token: "B", weightBps: 5000 }] });

      expect(res.status).toBe(400);
    });

    it("returns 400 when targetWeights is missing or not an array", async () => {
      const res = await request(app)
        .post(`/api/strategies/stablecoin-basket/${CONTRACT_ID}/rebalance-preview/validate`)
        .send({});

      expect(res.status).toBe(400);
    });
  });
});
