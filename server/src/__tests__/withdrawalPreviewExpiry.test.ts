/**
 * Withdrawal-preview quote expiry — Issue #1308.
 *
 * The preview now carries expiresAt/quoteTtlMs so transaction modals can
 * warn on stale quotes with one deterministic contract.
 */
import request from "supertest";
import { createApp } from "../app";
import { WITHDRAWAL_QUOTE_TTL_MS } from "../routes/withdrawalPreview";

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

describe("withdrawal-preview — quote expiry (#1308)", () => {
  it("returns expiresAt = quotedAt + TTL with quoteTtlMs", async () => {
    const res = await request(app)
      .post("/api/vaults/usdc/withdrawal-preview")
      .send({ amountUsd: 100, poolLiquidityUsd: 1_000_000, exitFeeBps: 0 });

    expect(res.status).toBe(200);
    expect(typeof res.body.quotedAt).toBe("string");
    expect(typeof res.body.expiresAt).toBe("string");
    expect(res.body.quoteTtlMs).toBe(WITHDRAWAL_QUOTE_TTL_MS);
    const quotedMs = new Date(res.body.quotedAt).getTime();
    const expiresMs = new Date(res.body.expiresAt).getTime();
    expect(expiresMs - quotedMs).toBe(WITHDRAWAL_QUOTE_TTL_MS);
  });

  it("keeps the quote fresh at issue time", async () => {
    const res = await request(app)
      .post("/api/vaults/usdc/withdrawal-preview")
      .send({ amountUsd: 100, poolLiquidityUsd: 1_000_000 });
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now() - 5_000,
    );
  });
});
