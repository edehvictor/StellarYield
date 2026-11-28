import express from "express";
import request from "supertest";
import yieldsRouter from "../routes/yields";
import * as yieldService from "../services/yieldService";
import * as netYieldEngine from "../services/netYieldEngine";
import { yieldReliabilityEngine } from "../services/yieldReliabilityService";
import { defaultYieldDisplayOperationManager } from "../../../shared/types/yieldDataDisplayOperation";

const app = express();
app.use("/api/yields", yieldsRouter);

const feedEntry = {
  protocolName: "Blend",
  protocolId: "blend",
  asset: "USDC",
  totalApy: 10,
  tvlUsd: 1_000_000,
};

describe("GET /api/yields operation identity", () => {
  beforeEach(() => {
    defaultYieldDisplayOperationManager.clear();
    jest.spyOn(yieldService, "getYieldDataWithCacheStatus").mockResolvedValue({
      data: [feedEntry] as never,
      cacheStatus: "hit" as never,
    });
    jest.spyOn(yieldReliabilityEngine, "calculateReliabilityScore").mockResolvedValue({
      status: "healthy",
      signals: { lastSuccessfulFetch: new Date().toISOString() },
      metrics: { freshness: 1 },
    } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    defaultYieldDisplayOperationManager.clear();
  });

  it("keeps legacy requests working without an operation identity", async () => {
    const res = await request(app).get("/api/yields");
    expect(res.status).toBe(200);
    expect(res.headers["x-operation-identity"]).toBeUndefined();
    expect(res.headers["x-yield-display-replayed"]).toBeUndefined();
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("rejects a malformed identity before reading yield data", async () => {
    const read = jest.spyOn(yieldService, "getYieldDataWithCacheStatus");
    const res = await request(app).get("/api/yields").set("X-Operation-Identity", "bad/key");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_YIELD_DISPLAY_OPERATION_IDENTITY");
    expect(read).not.toHaveBeenCalled();
  });

  it("computes net yield once and replays the committed result on a safe retry", async () => {
    const calculate = jest.spyOn(netYieldEngine, "calculateNetYield");

    const first = await request(app)
      .get("/api/yields")
      .set("X-Operation-Identity", "display_retry_1234");
    expect(first.status).toBe(200);
    expect(first.headers["x-operation-identity"]).toBe("display_retry_1234");
    expect(first.headers["x-yield-display-replayed"]).toBeUndefined();
    expect(calculate).toHaveBeenCalledTimes(1);

    const retry = await request(app)
      .get("/api/yields")
      .set("X-Operation-Identity", "display_retry_1234");
    expect(retry.status).toBe(200);
    expect(retry.headers["x-yield-display-replayed"]).toBe("true");
    expect(retry.body).toEqual(first.body);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(
      defaultYieldDisplayOperationManager.getOperation("display_retry_1234")?.status,
    ).toBe("committed");
  });

  it("rejects the same identity with different assumptions", async () => {
    const first = await request(app)
      .get("/api/yields?protocolFeeBps=45")
      .set("X-Operation-Identity", "display_conflict_1234");
    expect(first.status).toBe(200);

    const second = await request(app)
      .get("/api/yields?protocolFeeBps=60")
      .set("X-Operation-Identity", "display_conflict_1234");
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("YIELD_DISPLAY_OPERATION_IDENTITY_CONFLICT");
    expect(second.headers["cache-control"]).toBeUndefined();
  });

  it("preserves the previous display state on execution failure and allows a safe retry", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const calculate = jest
      .spyOn(netYieldEngine, "calculateNetYield")
      .mockImplementationOnce(() => {
        throw new Error("engine unavailable");
      });

    const failed = await request(app)
      .get("/api/yields")
      .set("X-Operation-Identity", "display_failure_1234");
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe("YIELD_DISPLAY_EXECUTION_FAILED");
    expect(failed.body.recoverable).toBe(true);
    expect(failed.headers["cache-control"]).toBeUndefined();
    expect(
      defaultYieldDisplayOperationManager.getOperation("display_failure_1234")?.status,
    ).toBe("failed");

    calculate.mockImplementation(
      () =>
        ({
          grossApy: 10,
          netApy: 9,
          feeDragApy: 1,
          assumptions: {},
          sensitivity: [],
          feeAttribution: {},
        }) as never,
    );
    const retried = await request(app)
      .get("/api/yields")
      .set("X-Operation-Identity", "display_failure_1234");
    expect(retried.status).toBe(200);
    expect(retried.headers["x-yield-display-replayed"]).toBeUndefined();
    expect(calculate).toHaveBeenCalledTimes(2);
  });
});
