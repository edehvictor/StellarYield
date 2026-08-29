/**
 * Tests for POST /api/vaults/:vaultId/withdrawal-preview
 *
 * Covers:
 *  - Instant withdrawal (no fee, deep liquidity)
 *  - Delayed withdrawal (queued vault)
 *  - Fee-bearing withdrawal (various bps rates)
 *  - Low-liquidity detection
 *  - Input validation (missing / invalid fields)
 */
import request from "supertest";
import { createApp } from "../app";

// Keep yieldService from making real network calls during CI
jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([]),
  getYieldDataWithCacheStatus: jest.fn().mockResolvedValue({
    data: [],
    cacheStatus: "MISS",
  }),
}));

jest.mock("../services/freezeService", () => ({
  freezeService: { isFrozen: jest.fn().mockReturnValue(false) },
}));

const app = createApp();

function post(vaultId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/vaults/${vaultId}/withdrawal-preview`)
    .send(body);
}

// ── Instant withdrawal (no fee, deep liquidity) ───────────────────────────

describe("withdrawal-preview — instant, no fee", () => {
  it("returns 200 with the expected response shape", async () => {
    const res = await post("usdc", {
      amountUsd: 100,
      poolLiquidityUsd: 1_000_000,
      exitFeeBps: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      vaultId: "usdc",
      requestedAmountUsd: 100,
      exitFeeBps: 0,
      processingDelaySeconds: 5,
    });
    expect(typeof res.body.estimatedNetUsd).toBe("number");
    expect(typeof res.body.exitFeeUsd).toBe("number");
    expect(typeof res.body.priceImpactPct).toBe("number");
    expect(typeof res.body.quotedAt).toBe("string");
  });

  it("produces zero exit fee when exitFeeBps is 0", async () => {
    const res = await post("usdc", {
      amountUsd: 500,
      poolLiquidityUsd: 2_000_000,
      exitFeeBps: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body.exitFeeUsd).toBe(0);
  });

  it("estimated net is close to requested when pool is very deep", async () => {
    const res = await post("usdc", {
      amountUsd: 100,
      poolLiquidityUsd: 100_000_000,
      exitFeeBps: 0,
    });

    expect(res.status).toBe(200);
    // $100 in a $100 M pool → price impact < 0.01 % → net ≈ $100
    expect(res.body.estimatedNetUsd).toBeGreaterThan(99.99);
    expect(res.body.isLowLiquidity).toBe(false);
  });

  it("optimistic >= estimated >= conservative", async () => {
    const res = await post("usdc", {
      amountUsd: 1_000,
      poolLiquidityUsd: 50_000,
      exitFeeBps: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body.optimisticNetUsd).toBeGreaterThanOrEqual(
      res.body.estimatedNetUsd,
    );
    expect(res.body.estimatedNetUsd).toBeGreaterThanOrEqual(
      res.body.conservativeNetUsd,
    );
  });

  it("exitFeeBps defaults to 0 when omitted", async () => {
    const res = await post("usdc", {
      amountUsd: 100,
      poolLiquidityUsd: 100_000,
    });

    expect(res.status).toBe(200);
    expect(res.body.exitFeeBps).toBe(0);
    expect(res.body.exitFeeUsd).toBe(0);
  });
});

// ── Delayed withdrawal (queued vault) ─────────────────────────────────────

describe("withdrawal-preview — delayed (queued vault)", () => {
  it("returns a delay > 5 s and a human label mentioning hours or queuing", async () => {
    const res = await post("defindex", {
      amountUsd: 200,
      poolLiquidityUsd: 500_000,
      exitFeeBps: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body.processingDelaySeconds).toBeGreaterThan(5);
    expect(res.body.processingDelayLabel).toMatch(/hour|queue/i);
  });
});

// ── Fee-bearing withdrawal ─────────────────────────────────────────────────

describe("withdrawal-preview — fee bearing", () => {
  it("deducts 1 % exit fee from net output", async () => {
    const res = await post("usdc", {
      amountUsd: 1_000,
      poolLiquidityUsd: 10_000_000,
      exitFeeBps: 100, // 1 %
    });

    expect(res.status).toBe(200);
    expect(res.body.exitFeeUsd).toBeCloseTo(10, 2); // $10 fee
    expect(res.body.estimatedNetUsd).toBeLessThan(1_000);
  });

  it("handles 100 % fee (exitFeeBps = 10000)", async () => {
    const res = await post("usdc", {
      amountUsd: 500,
      poolLiquidityUsd: 1_000_000,
      exitFeeBps: 10_000,
    });

    expect(res.status).toBe(200);
    expect(res.body.exitFeeUsd).toBeCloseTo(500, 1);
    expect(res.body.estimatedNetUsd).toBeCloseTo(0, 1);
  });

  it("echoes the exitFeeBps value", async () => {
    const res = await post("usdc", {
      amountUsd: 200,
      poolLiquidityUsd: 500_000,
      exitFeeBps: 50,
    });

    expect(res.status).toBe(200);
    expect(res.body.exitFeeBps).toBe(50);
  });
});

// ── Low-liquidity detection ────────────────────────────────────────────────

describe("withdrawal-preview — low-liquidity detection", () => {
  it("flags isLowLiquidity when price impact > 2 %", async () => {
    // $5 000 in a $10 000 pool → impact ≈ 33 %
    const res = await post("usdc", {
      amountUsd: 5_000,
      poolLiquidityUsd: 10_000,
      exitFeeBps: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body.isLowLiquidity).toBe(true);
    expect(res.body.priceImpactPct).toBeGreaterThan(2);
  });

  it("does NOT flag isLowLiquidity when impact is below 2 %", async () => {
    const res = await post("usdc", {
      amountUsd: 100,
      poolLiquidityUsd: 10_000_000,
      exitFeeBps: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body.isLowLiquidity).toBe(false);
  });

  it("handles empty pool (poolLiquidityUsd = 0) — 100 % price impact", async () => {
    const res = await post("usdc", {
      amountUsd: 100,
      poolLiquidityUsd: 0,
      exitFeeBps: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body.priceImpactPct).toBeCloseTo(100, 1);
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("withdrawal-preview — input validation", () => {
  it("rejects missing amountUsd with INVALID_AMOUNT", async () => {
    const res = await post("usdc", { poolLiquidityUsd: 100_000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_AMOUNT");
  });

  it("rejects amountUsd = 0 with INVALID_AMOUNT", async () => {
    const res = await post("usdc", {
      amountUsd: 0,
      poolLiquidityUsd: 100_000,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_AMOUNT");
  });

  it("rejects negative amountUsd with INVALID_AMOUNT", async () => {
    const res = await post("usdc", {
      amountUsd: -50,
      poolLiquidityUsd: 100_000,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_AMOUNT");
  });

  it("rejects missing poolLiquidityUsd with INVALID_LIQUIDITY", async () => {
    const res = await post("usdc", { amountUsd: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_LIQUIDITY");
  });

  it("rejects negative poolLiquidityUsd with INVALID_LIQUIDITY", async () => {
    const res = await post("usdc", {
      amountUsd: 100,
      poolLiquidityUsd: -1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_LIQUIDITY");
  });

  it("rejects exitFeeBps > 10000 with INVALID_FEE_BPS", async () => {
    const res = await post("usdc", {
      amountUsd: 100,
      poolLiquidityUsd: 100_000,
      exitFeeBps: 10_001,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_FEE_BPS");
  });

  it("rejects negative exitFeeBps with INVALID_FEE_BPS", async () => {
    const res = await post("usdc", {
      amountUsd: 100,
      poolLiquidityUsd: 100_000,
      exitFeeBps: -1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_FEE_BPS");
  });
});
