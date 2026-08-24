import request from "supertest";
import { createApp } from "../app";
import { getZapQuote } from "../services/zapQuote";

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

jest.mock("../services/zapQuote", () => ({
  getZapQuote: jest.fn(),
}));

const mockGetZapQuote = getZapQuote as jest.MockedFunction<typeof getZapQuote>;

const SAME_TOKEN = "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("POST /api/zap/quote error recoverability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("marks unexpected quote failures as recoverable", async () => {
    mockGetZapQuote.mockRejectedValueOnce(new Error("router simulation unavailable"));

    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({
        inputTokenContract: SAME_TOKEN,
        vaultTokenContract: SAME_TOKEN,
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("QUOTE_FAILED");
    expect(res.body.message).toBe("Quote failed");
    expect(res.body.recoverable).toBe(true);
  });

  it("leaves validation failures without the recovery flag", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({ inputTokenContract: "A" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("MISSING_FIELDS");
    expect(res.body.message).toContain("inputTokenContract");
    expect(res.body.recoverable).toBeUndefined();
  });
});
