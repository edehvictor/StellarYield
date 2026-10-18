import request from "supertest";
import express from "express";
import healthRouter, {
  recordKeeperHeartbeat,
  resetKeeperHeartbeats,
  KEEPER_HEALTH_THRESHOLDS,
} from "../routes/health";

describe("Keeper Heartbeat Health & Recovery Routes (#1034)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/health", healthRouter);

  beforeEach(() => {
    resetKeeperHeartbeats();
  });

  it("returns 200 with missing status when no heartbeats have been registered", async () => {
    const res = await request(app).get("/api/health/keepers");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.missingCount).toBe(4);
    expect(res.body.keepers.rebalance.status).toBe("missing");
    expect(res.body.keepers.rebalance.recoveryGuidance).toContain("restart rebalance keeper");
  });

  it("records heartbeat and reports healthy status", async () => {
    const postRes = await request(app)
      .post("/api/health/keepers/heartbeat")
      .send({ worker: "liquidation" });
    expect(postRes.status).toBe(200);
    expect(postRes.body.status).toBe("ok");

    const getRes = await request(app).get("/api/health/keepers");
    expect(getRes.status).toBe(200);
    expect(getRes.body.keepers.liquidation.status).toBe("healthy");
    expect(getRes.body.keepers.liquidation.lastHeartbeat).toBeTruthy();
    expect(typeof getRes.body.keepers.liquidation.ageMs).toBe("number");
  });

  it("reports stale status when heartbeat age exceeds threshold", async () => {
    const staleTime = Date.now() - (KEEPER_HEALTH_THRESHOLDS.HEALTHY_MAX_AGE_MS + 10_000);
    recordKeeperHeartbeat("reward", staleTime);

    const res = await request(app).get("/api/health/keepers");
    expect(res.status).toBe(200);
    expect(res.body.keepers.reward.status).toBe("stale");
    expect(res.body.keepers.reward.ageMs).toBeGreaterThan(KEEPER_HEALTH_THRESHOLDS.HEALTHY_MAX_AGE_MS);
    expect(res.body.keepers.reward.degradedBehavior).toContain("Yield harvesting paused");
  });

  it("rejects invalid worker heartbeat with 400", async () => {
    const res = await request(app)
      .post("/api/health/keepers/heartbeat")
      .send({ worker: "invalid_worker" });
    expect(res.status).toBe(400);
  });
});
