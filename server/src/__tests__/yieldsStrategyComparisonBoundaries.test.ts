/**
 * GET /api/yields — strategy comparison boundary values (#1922).
 */
import express from "express";
import request from "supertest";
import yieldsRouter, {
  MAX_ASSUMPTION_BPS,
  MIN_ASSUMPTION_BPS,
  parseAssumptionBps,
} from "../routes/yields";
import * as yieldService from "../services/yieldService";

describe("parseAssumptionBps", () => {
  it("accepts zero, the maximum and values near it", () => {
    expect(parseAssumptionBps(String(MIN_ASSUMPTION_BPS))).toBe(0);
    expect(parseAssumptionBps(String(MAX_ASSUMPTION_BPS))).toBe(10_000);
    expect(parseAssumptionBps("9999.5")).toBe(9_999.5);
  });

  it("leaves absent, empty and non-numeric values to the engine default", () => {
    expect(parseAssumptionBps(undefined)).toBeUndefined();
    expect(parseAssumptionBps("")).toBeUndefined();
    expect(parseAssumptionBps("abc")).toBeUndefined();
    expect(parseAssumptionBps(["10", "20"])).toBeUndefined();
  });

  it("rejects negative, above-maximum and infinite values", () => {
    expect(parseAssumptionBps("-1")).toBeNull();
    expect(parseAssumptionBps("10001")).toBeNull();
    expect(parseAssumptionBps("Infinity")).toBeNull();
    expect(parseAssumptionBps("1e309")).toBeNull();
  });
});

describe("GET /api/yields with assumptions", () => {
  // The router alone, so these checks do not depend on unrelated app wiring.
  const app = express();
  app.use("/api/yields", yieldsRouter);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("serves zero and maximum assumptions with finite net figures", async () => {
    for (const bps of ["0", "10000"]) {
      const res = await request(app).get(
        `/api/yields?protocolFeeBps=${bps}&vaultFeeBps=${bps}&rebalanceCostBps=${bps}&slippageBps=${bps}`,
      );
      expect(res.status).toBe(200);
      for (const entry of res.body as Array<{ netApy: number; feeDragApy: number }>) {
        expect(Number.isFinite(entry.netApy)).toBe(true);
        expect(Number.isFinite(entry.feeDragApy)).toBe(true);
      }
    }
  });

  it("rejects an out-of-range assumption with 400 before reading yield data", async () => {
    const spy = jest.spyOn(yieldService, "getYieldDataWithCacheStatus");
    const res = await request(app).get("/api/yields?protocolFeeBps=-5&slippageBps=20000");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_ASSUMPTION");
    expect(res.body.details).toEqual({ fields: ["protocolFeeBps", "slippageBps"] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers a failed read with one 500 body, then serves the retry", async () => {
    const real = yieldService.getYieldDataWithCacheStatus;
    jest
      .spyOn(yieldService, "getYieldDataWithCacheStatus")
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockImplementationOnce(real);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await request(app).get("/api/yields");
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual(
      expect.objectContaining({ error: "YIELD_FETCH_FAILED", recoverable: true }),
    );

    const retried = await request(app).get("/api/yields");
    expect(retried.status).toBe(200);
    expect(Array.isArray(retried.body)).toBe(true);
  });
});
