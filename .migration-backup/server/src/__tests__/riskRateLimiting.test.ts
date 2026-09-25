import express from "express";
import request from "supertest";
import rateLimit from "express-rate-limit";

function createTestApp(maxRequests: number, windowMs: number = 15 * 60 * 1000) {
  const app = express();
  app.use(express.json());

  const limiter = rateLimit({
    windowMs,
    max: maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." },
  });

  app.post("/api/risk/drift/detect", limiter, (_req, res) => {
    res.json({ success: true, data: { driftDetected: false } });
  });

  app.post("/api/risk/dispersion/compute", limiter, (_req, res) => {
    res.json({ success: true, data: { dispersion: 0.05 } });
  });

  app.get("/api/risk/stress-matrix/run", limiter, (_req, res) => {
    res.json({ success: true, data: { scenarios: [] } });
  });

  app.get("/api/risk/drift/thresholds/conservative", (_req, res) => {
    res.json({ success: true, data: { preference: "conservative" } });
  });

  return app;
}

describe("Risk Analysis Rate Limiting", () => {
  describe("rate limited endpoints", () => {
    const app = createTestApp(3, 60_000);

    it("allows requests within limit", async () => {
      const res = await request(app)
        .post("/api/risk/drift/detect")
        .send({ userId: "u1", statedPreference: "balanced", positions: [{ weightPct: 50 }] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 429 after exceeding limit", async () => {
      const testApp = createTestApp(2, 60_000);

      await request(testApp).post("/api/risk/drift/detect").send({});
      await request(testApp).post("/api/risk/drift/detect").send({});
      const third = await request(testApp).post("/api/risk/drift/detect").send({});

      expect(third.status).toBe(429);
      expect(third.body.error).toContain("Too many requests");
    });

    it("returns rate limit headers", async () => {
      const testApp = createTestApp(5, 60_000);
      const res = await request(testApp).post("/api/risk/drift/detect").send({});

      expect(res.headers["ratelimit-limit"]).toBeDefined();
      expect(res.headers["ratelimit-remaining"]).toBeDefined();
    });
  });

  describe("rate limit reset", () => {
    it("allows requests again after window resets", async () => {
      const testApp = createTestApp(1, 100);

      await request(testApp).post("/api/risk/drift/detect").send({});
      const blocked = await request(testApp).post("/api/risk/drift/detect").send({});
      expect(blocked.status).toBe(429);

      await new Promise((r) => setTimeout(r, 150));

      const afterReset = await request(testApp).post("/api/risk/drift/detect").send({});
      expect(afterReset.status).toBe(200);
    });
  });

  describe("non-rate-limited endpoints", () => {
    it("threshold lookups are not rate limited", async () => {
      const testApp = createTestApp(1, 60_000);

      await request(testApp).post("/api/risk/drift/detect").send({});

      const thresholdRes = await request(testApp).get("/api/risk/drift/thresholds/conservative");
      expect(thresholdRes.status).toBe(200);
    });
  });

  describe("different endpoints share appropriate limiters", () => {
    it("drift and dispersion share the analysis limiter", async () => {
      const testApp = createTestApp(2, 60_000);

      await request(testApp).post("/api/risk/drift/detect").send({});
      await request(testApp).post("/api/risk/dispersion/compute").send({});
      const third = await request(testApp).post("/api/risk/drift/detect").send({});

      expect(third.status).toBe(429);
    });
  });

  describe("response format on rate limit", () => {
    it("returns JSON error body on 429", async () => {
      const testApp = createTestApp(1, 60_000);

      await request(testApp).post("/api/risk/drift/detect").send({});
      const res = await request(testApp).post("/api/risk/drift/detect").send({});

      expect(res.status).toBe(429);
      expect(res.body).toHaveProperty("error");
      expect(typeof res.body.error).toBe("string");
    });
  });
});
