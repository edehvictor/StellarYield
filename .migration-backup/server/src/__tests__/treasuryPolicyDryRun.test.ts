import request from "supertest";
import express from "express";
import { authMiddleware } from "../middleware/auth";
import treasuryRouter from "../routes/treasury";
import {
  listPolicies,
  resetPolicyStore,
} from "../services/allocationPolicyDsl";

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use("/api/treasury", treasuryRouter);

const VALID_POLICY = {
  name: "Balanced Allocation",
  version: "1.0.0",
  description: "A balanced allocation policy for stable returns",
  rules: [
    {
      id: "high-yield-stable",
      description: "High yield with low volatility",
      weight: 0.6,
      conditions: {
        minTvl: 1_000_000,
        maxVolatility: 15,
        minApy: 5,
      },
      cooldown: {
        durationMs: 3600000,
      },
      threshold: {
        max: 70,
      },
    },
    {
      id: "growth-focused",
      description: "Growth with higher volatility tolerance",
      weight: 0.4,
      conditions: {
        minTvl: 500_000,
        maxVolatility: 30,
        minApy: 8,
      },
      threshold: {
        min: 10,
        max: 50,
      },
    },
  ],
  defaultRule: {
    conditions: {
      maxVolatility: 50,
    },
  },
};

describe("POST /api/treasury/policy/dry-run (#1309)", () => {
  beforeEach(() => {
    resetPolicyStore();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app)
      .post("/api/treasury/policy/dry-run")
      .send({ policy: VALID_POLICY })
      .expect(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("validates a valid policy without persisting it", async () => {
    const before = listPolicies().length;
    const res = await request(app)
      .post("/api/treasury/policy/dry-run")
      .set("Authorization", "Bearer mock-admin-token")
      .send({ policy: VALID_POLICY })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data.persisted).toBe(false);
    expect(res.body.data.policy.name).toBe("Balanced Allocation");
    expect(res.body.data.policy.rules).toHaveLength(2);
    expect(res.body.data.evaluations).toBeUndefined();
    expect(listPolicies()).toHaveLength(before);
    expect(listPolicies().find((p) => p.name === "Balanced Allocation")).toBeUndefined();
  });

  it("returns INVALID_POLICY with details.errors for invalid policy", async () => {
    const res = await request(app)
      .post("/api/treasury/policy/dry-run")
      .set("Authorization", "Bearer mock-admin-token")
      .send({ policy: { name: "", version: "1.0.0", rules: [] } })
      .expect(422);

    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("INVALID_POLICY");
    expect(Array.isArray(res.body.error.details.errors)).toBe(true);
    expect(res.body.error.details.errors.length).toBeGreaterThan(0);
  });

  it("returns 400 when policy is missing", async () => {
    const res = await request(app)
      .post("/api/treasury/policy/dry-run")
      .set("Authorization", "Bearer mock-admin-token")
      .send({})
      .expect(400);
    expect(res.body.error.code).toBe("INVALID_POLICY");
  });

  it("evaluates provided contexts without storing the policy", async () => {
    const context = {
      vaultId: "blend",
      tvlUsd: 2_000_000,
      apyPct: 10,
      volatilityPct: 10,
      currentAllocationPct: 20,
    };
    const res = await request(app)
      .post("/api/treasury/policy/dry-run")
      .set("Authorization", "Bearer mock-admin-token")
      .send({ policy: VALID_POLICY, contexts: [context] })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data.persisted).toBe(false);
    expect(Array.isArray(res.body.data.evaluations)).toBe(true);
    expect(res.body.data.evaluations).toHaveLength(1);
    expect(typeof res.body.data.evaluations[0].matched).toBe("boolean");
    expect(listPolicies()).toHaveLength(0);
  });

  it("returns 400 when contexts is not an array", async () => {
    await request(app)
      .post("/api/treasury/policy/dry-run")
      .set("Authorization", "Bearer mock-admin-token")
      .send({ policy: VALID_POLICY, contexts: "nope" })
      .expect(400);
  });
});
