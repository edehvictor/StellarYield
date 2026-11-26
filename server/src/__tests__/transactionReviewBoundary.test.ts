import request from "supertest";
import { createApp } from "../app";
import { getAssetConfigVersion, computeRouteHash } from "../services/zapQuote";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";

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

// Mock freezeService
jest.mock("../services/freezeService", () => ({
  freezeService: {
    isFrozen: jest.fn().mockReturnValue(false),
  },
}));

// Mock feeOracleService
jest.mock("../services/feeOracleService", () => ({
  ...jest.requireActual("../services/feeOracleService"),
  getFeeOracleEstimate: jest.fn().mockResolvedValue({
    networkPassphrase: "Test SDF Network ; September 2015",
    sampleSize: 20,
    utilization: { averageTxSetSize: 1, maxTxSetSize: 2, congestionRatio: 0.1 },
    fees: { low: 100, average: 200, high: 400 },
    bufferedFees: { low: 105, average: 210, high: 420 },
    feeBuffer: { network: "testnet", multiplier: 1.05 },
    generatedAt: "2026-01-01T00:00:00.000Z",
  }),
}));

const VALID_TOKEN = "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Transaction Review & Quote Server Boundary Hardening (#1889)", () => {
  const app = createApp();

  describe("POST /api/zap/quote - input boundary validation", () => {
    it("rejects negative amountInStroops with typed INVALID_AMOUNT (400)", async () => {
      const res = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: VALID_TOKEN,
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "-1000",
          inputDecimals: 7,
          vaultDecimals: 7,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_AMOUNT");
    });

    it("rejects zero amountInStroops with typed INVALID_AMOUNT (400)", async () => {
      const res = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: VALID_TOKEN,
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "0",
          inputDecimals: 7,
          vaultDecimals: 7,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_AMOUNT");
    });

    it("rejects non-integer / malformed amountInStroops strings with 400", async () => {
      const res = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: VALID_TOKEN,
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "100.5",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_AMOUNT");
    });

    it("rejects empty or whitespace-only contract IDs with INVALID_CONTRACT (400)", async () => {
      const res = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: "   ",
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "10000",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_CONTRACT");
    });

    it("rejects out-of-range slippageTolerance (> 50%) with INVALID_SLIPPAGE (400)", async () => {
      const res = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: VALID_TOKEN,
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "10000",
          slippageTolerance: 55,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_SLIPPAGE");
    });

    it("rejects negative slippageTolerance with INVALID_SLIPPAGE (400)", async () => {
      const res = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: VALID_TOKEN,
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "10000",
          slippageTolerance: -1,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_SLIPPAGE");
    });

    it("rejects invalid decimals (< 0 or > 18) with INVALID_DECIMALS (400)", async () => {
      const res = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: VALID_TOKEN,
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "10000",
          inputDecimals: 25,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_DECIMALS");
    });

    it("rejects malformed wallet address with INVALID_ADDRESS (400)", async () => {
      const res = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: VALID_TOKEN,
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "10000",
          walletAddress: "not-a-valid-stellar-addr",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_ADDRESS");
    });

    it("allows safe retry with valid payload after rejection", async () => {
      // 1. First attempt fails due to malformed input
      const failRes = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: VALID_TOKEN,
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "-999",
        });
      expect(failRes.status).toBe(400);

      // 2. Safe retry with corrected valid input succeeds without state mutation
      const successRes = await request(app)
        .post("/api/zap/quote")
        .send({
          inputTokenContract: VALID_TOKEN,
          vaultTokenContract: VALID_TOKEN,
          amountInStroops: "1000",
          inputDecimals: 7,
          vaultDecimals: 7,
        });
      expect(successRes.status).toBe(200);
      expect(successRes.body.expectedAmountOutStroops).toBe("1000");
    });
  });

  describe("POST /api/zap/verify - quote review boundary verification", () => {
    it("safely rejects malformed path elements with ROUTE_MISMATCH without 500 crashing", async () => {
      const res = await request(app)
        .post("/api/zap/verify")
        .send({
          path: [null, {}],
          assetConfigVersion: getAssetConfigVersion(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ROUTE_MISMATCH");
    });

    it("safely rejects malformed assumption fingerprint with INVALID_QUOTE", async () => {
      const supportedToken = getZapSupportedAssetsPayload().vaultToken.contractId;
      const path = [{ contractId: supportedToken }];
      const res = await request(app)
        .post("/api/zap/verify")
        .send({
          path,
          routeHash: computeRouteHash(path),
          assetConfigVersion: getAssetConfigVersion(),
          assumptionFingerprint: "not-a-64-character-hex-digest",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_QUOTE");
    });
  });

  describe("POST /api/zap/fingerprint - payload boundary validation", () => {
    it("returns typed 400 INVALID_ASSUMPTIONS when payload has malformed fields", async () => {
      const res = await request(app)
        .post("/api/zap/fingerprint")
        .send({
          amountInStroops: "not-digits",
          inputTokenContract: VALID_TOKEN,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_ASSUMPTIONS");
    });
  });
});
