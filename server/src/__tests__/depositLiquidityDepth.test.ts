import request from "supertest";
import express from "express";
import depositsRouter, { checkRouteLiquidityDepth } from "../routes/deposits";

const app = express();
app.use(express.json());
app.use("/api/deposits", depositsRouter);

describe("checkRouteLiquidityDepth (#1312)", () => {
  it("skips when depth is unknown", () => {
    const result = checkRouteLiquidityDepth({ amountUsd: 1_000_000 });
    expect(result).toEqual({ checked: false, utilizationPct: null, block: false });
  });

  it("skips when amountUsd is unknown or zero", () => {
    expect(checkRouteLiquidityDepth({ routeLiquidityDepthUsd: 100_000 }).checked).toBe(false);
    expect(
      checkRouteLiquidityDepth({ amountUsd: 0, routeLiquidityDepthUsd: 100_000 }).checked,
    ).toBe(false);
  });

  it("allows deposit under the 25% cap", () => {
    const result = checkRouteLiquidityDepth({
      amountUsd: 20_000,
      routeLiquidityDepthUsd: 100_000,
    });
    expect(result.checked).toBe(true);
    expect(result.block).toBe(false);
    expect(result.utilizationPct).toBe(20);
  });

  it("blocks deposit over the 25% cap", () => {
    const result = checkRouteLiquidityDepth({
      amountUsd: 30_000,
      routeLiquidityDepthUsd: 100_000,
    });
    expect(result.block).toBe(true);
    expect(result.utilizationPct).toBe(30);
    expect(result.reason).toContain("route liquidity depth");
  });

  it("respects custom max utilization fraction", () => {
    expect(
      checkRouteLiquidityDepth({
        amountUsd: 20_000,
        routeLiquidityDepthUsd: 100_000,
        maxUtilizationFraction: 0.1,
      }).block,
    ).toBe(true);
    expect(
      checkRouteLiquidityDepth({
        amountUsd: 40_000,
        routeLiquidityDepthUsd: 100_000,
        maxUtilizationFraction: 0.5,
      }).block,
    ).toBe(false);
  });
});

describe("POST /api/deposits/recommend depth gate (#1312)", () => {
  const assets = [{ symbol: "USDC", amountInStroops: "1000000" }];

  it("returns 400 when assets missing", async () => {
    await request(app).post("/api/deposits/recommend").send({}).expect(400);
  });

  it("rejects oversized deposit with INSUFFICIENT_LIQUIDITY_DEPTH", async () => {
    const res = await request(app)
      .post("/api/deposits/recommend")
      .send({
        assets,
        amountUsd: 50_000,
        routeLiquidityDepthUsd: 100_000,
      })
      .expect(422);

    expect(res.body.error).toBe("INSUFFICIENT_LIQUIDITY_DEPTH");
    expect(res.body.message).toContain("liquidity depth");
    expect(res.body.details).toMatchObject({
      amountUsd: 50_000,
      routeLiquidityDepthUsd: 100_000,
    });
  });

  it("rejects invalid amountUsd type", async () => {
    await request(app)
      .post("/api/deposits/recommend")
      .send({ assets, amountUsd: "lots" })
      .expect(400);
  });

  it("rejects invalid routeLiquidityDepthUsd type", async () => {
    await request(app)
      .post("/api/deposits/recommend")
      .send({ assets, routeLiquidityDepthUsd: "deep" })
      .expect(400);
  });

  it("accepts deposit under the depth cap (skips when depth unknown)", async () => {
    // Without depth, the check is skipped for backward compatibility.
    const res = await request(app)
      .post("/api/deposits/recommend")
      .send({ assets, amountUsd: 1_000_000 })
      .expect(200);
    expect(res.body.routes || res.body.warnings).toBeDefined();
  });

  it("accepts deposit under the depth cap when depth is provided", async () => {
    process.env.DEPOSIT_ROUTE_LIQUIDITY_DEPTH_USD = "1000000";
    try {
      const res = await request(app)
        .post("/api/deposits/recommend")
        .send({ assets, amountUsd: 100, routeLiquidityDepthUsd: 1_000_000 })
        .expect(200);
      expect(res.body.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("liquidity depth check passed")]),
      );
    } finally {
      delete process.env.DEPOSIT_ROUTE_LIQUIDITY_DEPTH_USD;
    }
  });
});
