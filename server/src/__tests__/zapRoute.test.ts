import request from "supertest";
import { createApp } from "../app";

// Mock yieldService to prevent real Stellar network calls during CI
jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "default", tvl: 10_000_000 },
  ]),
  getYieldDataWithCacheStatus: jest.fn().mockResolvedValue({
    data: [{ protocolName: "default", tvl: 10_000_000 }],
    cacheStatus: "MISS",
  }),
}));

// Mock freezeService so no protocol is frozen by default
jest.mock("../services/freezeService", () => ({
  freezeService: {
    isFrozen: jest.fn().mockReturnValue(false),
  },
}));

describe("POST /api/zap/quote", () => {
  it("returns a fallback quote for identical tokens", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        vaultTokenContract: "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

    expect(res.status).toBe(200);
    expect(res.body.expectedAmountOutStroops).toBe("1000");
    expect(res.body.source).toBe("fallback_rate");
  });

  it("returns 400 when body is incomplete", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({ inputTokenContract: "A" });

    expect(res.status).toBe(400);
  });
});
