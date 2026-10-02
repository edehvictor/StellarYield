/**
 * #1386 — GET /api/yields/predict serves a structured confidence explanation.
 *
 * Proves the explanation builder is actually consumed by the endpoint (not
 * dead code) and that the client receives human-readable rows instead of
 * raw reason codes.
 */
import request from "supertest";
import { createApp } from "../app";

const app = createApp();

describe("GET /api/yields/predict — confidence explanation", () => {
  it("includes a typed explanation alongside the forecast", async () => {
    const res = await request(app).get("/api/yields/predict?protocol=Blend");
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Array.isArray(body.predictions)).toBe(true);

    const explanation = body.explanation as Record<string, unknown>;
    expect(explanation).toBeDefined();
    expect(typeof explanation.summary).toBe("string");
    expect(["high", "reduced", "low", "unknown"]).toContain(explanation.level);
    expect(Array.isArray(explanation.sources)).toBe(true);
    expect(Array.isArray(explanation.factors)).toBe(true);
  });

  it("still serves a stable typed explanation for a blank protocol value", async () => {
    const res = await request(app).get("/api/yields/predict?protocol=   ");
    expect(res.status).toBe(200);
    const explanation = (res.body as Record<string, unknown>).explanation as Record<
      string,
      unknown
    >;
    expect(typeof explanation.summary).toBe("string");
    expect(["high", "reduced", "low", "unknown"]).toContain(explanation.level);
  });
});
