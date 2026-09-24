/**
 * Deposits Route Tests — vault deposit amount validation (#1317)
 */
import request from "supertest";
import express, { Express } from "express";
import depositsRouter from "../deposits";
import { recommendDepositRouting } from "../../services/depositRoutingService";
import { getZapSupportedAssetsPayload } from "../../config/zapAssetsConfig";
import {
  MIN_DEPOSIT_AMOUNT_STROOPS,
  MAX_DEPOSIT_AMOUNT_STROOPS,
} from "../../utils/depositAmountValidation";

jest.mock("../../services/depositRoutingService");
jest.mock("../../config/zapAssetsConfig");

const mockRecommend = recommendDepositRouting as jest.MockedFunction<
  typeof recommendDepositRouting
>;
const mockGetPayload = getZapSupportedAssetsPayload as jest.MockedFunction<
  typeof getZapSupportedAssetsPayload
>;

describe("POST /api/deposits/recommend — deposit amount bounds (#1317)", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/deposits", depositsRouter);

    mockGetPayload.mockReturnValue({
      assets: [{ symbol: "XLM", name: "Stellar Lumens", contractId: "C_XLM", decimals: 7 }],
      vaultToken: { symbol: "USDC", name: "USD Coin", contractId: "C_USDC", decimals: 7 },
      vaultContractId: "C_USDC",
    });

    mockRecommend.mockResolvedValue({
      vaultToken: { symbol: "USDC", contractId: "C_USDC", decimals: 7 },
      routes: [],
      unsupportedAssets: [],
      totals: {
        routableAssets: 0,
        expectedVaultAmountStroops: "0",
        estimatedNetworkFeeStroops: "0",
      },
      warnings: [],
      generatedAt: new Date().toISOString(),
    });
  });

  it("rejects a deposit below the minimum", async () => {
    const res = await request(app)
      .post("/api/deposits/recommend")
      .send({ assets: [{ symbol: "XLM", amountInStroops: "1" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("DEPOSIT_BELOW_MINIMUM");
    expect(mockRecommend).not.toHaveBeenCalled();
  });

  it("rejects a deposit above the maximum", async () => {
    const res = await request(app)
      .post("/api/deposits/recommend")
      .send({
        assets: [
          { symbol: "XLM", amountInStroops: (MAX_DEPOSIT_AMOUNT_STROOPS + 1n).toString() },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("DEPOSIT_ABOVE_MAXIMUM");
    expect(mockRecommend).not.toHaveBeenCalled();
  });

  it("accepts a deposit exactly at the minimum boundary", async () => {
    const res = await request(app)
      .post("/api/deposits/recommend")
      .send({
        assets: [{ symbol: "XLM", amountInStroops: MIN_DEPOSIT_AMOUNT_STROOPS.toString() }],
      });

    expect(res.status).toBe(200);
    expect(mockRecommend).toHaveBeenCalledWith([
      { symbol: "XLM", amountInStroops: MIN_DEPOSIT_AMOUNT_STROOPS.toString() },
    ]);
  });

  it("accepts a deposit exactly at the maximum boundary", async () => {
    const res = await request(app)
      .post("/api/deposits/recommend")
      .send({
        assets: [{ symbol: "XLM", amountInStroops: MAX_DEPOSIT_AMOUNT_STROOPS.toString() }],
      });

    expect(res.status).toBe(200);
    expect(mockRecommend).toHaveBeenCalledWith([
      { symbol: "XLM", amountInStroops: MAX_DEPOSIT_AMOUNT_STROOPS.toString() },
    ]);
  });

  it("accepts a normal, mid-range deposit amount", async () => {
    const res = await request(app)
      .post("/api/deposits/recommend")
      .send({ assets: [{ symbol: "XLM", amountInStroops: "10000000" }] });

    expect(res.status).toBe(200);
    expect(mockRecommend).toHaveBeenCalledWith([
      { symbol: "XLM", amountInStroops: "10000000" },
    ]);
  });

  it("still rejects a zero amount via the existing INVALID_AMOUNT check (unchanged behavior)", async () => {
    const res = await request(app)
      .post("/api/deposits/recommend")
      .send({ assets: [{ symbol: "XLM", amountInStroops: "0" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_AMOUNT");
    expect(mockRecommend).not.toHaveBeenCalled();
  });

  it("validates each asset in a multi-asset basket independently", async () => {
    const res = await request(app)
      .post("/api/deposits/recommend")
      .send({
        assets: [
          { symbol: "XLM", amountInStroops: "10000000" }, // valid
          { symbol: "USDC", amountInStroops: "5" }, // below minimum
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("DEPOSIT_BELOW_MINIMUM");
    expect(res.body.message).toContain("USDC");
    expect(mockRecommend).not.toHaveBeenCalled();
  });
});
