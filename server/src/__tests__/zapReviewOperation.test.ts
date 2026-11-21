/**
 * Regression tests for review operation identity handling on the server (#1888).
 * The server does not apply the deposit effect, but it must reject malformed
 * identities at the boundary and correlate valid ones through review errors.
 */

import request from "supertest";
import { createApp } from "../app";

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

const OPERATION_ID = "txrev_server_test_123";
const QUOTE_BODY = {
  inputTokenContract: "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  vaultTokenContract: "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  amountInStroops: "1000",
  inputDecimals: 7,
  vaultDecimals: 7,
};

describe("review operation identity header", () => {
  it("accepts a valid identity, echoes it, and backward-compatibly allows no header", async () => {
    const withHeader = await request(createApp())
      .post("/api/zap/quote")
      .set("X-Operation-Identity", OPERATION_ID)
      .send(QUOTE_BODY);

    expect(withHeader.status).toBe(200);
    expect(withHeader.headers["x-operation-identity"]).toBe(OPERATION_ID);

    const withoutHeader = await request(createApp()).post("/api/zap/quote").send(QUOTE_BODY);
    expect(withoutHeader.status).toBe(200);
    expect(withoutHeader.body.operationId).toBeUndefined();
  });

  it("includes the operation id in a typed review error response", async () => {
    const res = await request(createApp())
      .post("/api/zap/verify")
      .set("X-Operation-Identity", OPERATION_ID)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.operationId).toBe(OPERATION_ID);
    expect(res.body.diagnostics).toEqual(expect.any(Array));
    expect(res.body.diagnostics.length).toBeGreaterThan(0);
  });

  it("rejects a malformed identity before the review stage runs", async () => {
    const res = await request(createApp())
      .post("/api/zap/verify")
      .set("X-Operation-Identity", "bad id with spaces")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_OPERATION_IDENTITY");
    expect(res.body.operationId).toBeUndefined();
    expect(res.body.recoverable).toBe(false);
    expect(res.body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "VALIDATION_FAILED", stage: "request-validation" }),
      ]),
    );
  });
});
