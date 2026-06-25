/**
 * Dry-run preview endpoint tests for reward schedule health and payout timing.
 */

import request from "supertest";
import { app } from "../app";

describe("GET /api/rewards/dry-run", () => {
  it("returns 400 when ?now is not a valid ISO date", async () => {
    const res = await request(app).get("/api/rewards/dry-run?now=bad");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query");
    expect(typeof res.body.error).toBe("string");
  });

  it("returns a preview payload without mutating state", async () => {
    const res = await request(app).get("/api/rewards/dry-run");
    expect(res.status).toBe(200);
    expect(typeof res.body.generatedAt).toBe("string");
    expect(typeof res.body.referenceDate).toBe("string");
    expect(Array.isArray(res.body.health)).toBe(true);
  });
});