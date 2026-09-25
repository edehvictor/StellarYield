import express from "express";
import request from "supertest";
import auditReplayRouter from "../routes/auditReplay";

function createAuditReplayApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/audit-replay", auditReplayRouter);
  return app;
}

describe("audit replay routes", () => {
  it("returns summary envelope with counts", async () => {
    const app = createAuditReplayApp();

    await request(app).post("/api/audit-replay/record").send({
      strategyId: "summary-route",
      inputs: {
        portfolioState: { USDC: 1000 },
        marketConditions: { regime: "normal" },
        riskMetrics: { VaR: 10 },
        timestamp: new Date("2026-01-01T00:00:00.000Z"),
      },
      outputs: {
        recommendedAction: "hold",
        reasoning: { note: "test" },
        confidence: 0.85,
        stateTransition: { USDC: 1000 },
      },
      intermediateScores: { riskScore: 10 },
      executionTime: 20,
    });

    const res = await request(app).get(
      "/api/audit-replay/summary?strategyId=summary-route&limit=10",
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary).toMatchObject({
      total: expect.any(Number),
      deterministicCount: expect.any(Number),
      discrepancyCount: expect.any(Number),
      mismatchRate: expect.any(Number),
    });
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });

  it("returns 400 when required record fields are missing", async () => {
    const app = createAuditReplayApp();
    const res = await request(app).post("/api/audit-replay/record").send({
      strategyId: "bad",
    });
    expect(res.status).toBe(400);
  });
});
