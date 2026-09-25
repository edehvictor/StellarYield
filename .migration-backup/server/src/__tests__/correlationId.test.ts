import express, { Request, Response } from "express";
import request from "supertest";
import {
  correlationIdMiddleware,
  CORRELATION_ID_HEADER,
  getCorrelationId,
  getRequestId,
} from "../middleware/correlationId";

function buildApp() {
  const app = express();
  app.use(correlationIdMiddleware);
  app.get("/ping", (req: Request, res: Response) => {
    res.json({
      correlationId: getCorrelationId(req),
      requestId: getRequestId(req),
    });
  });
  return app;
}

describe("correlationIdMiddleware", () => {
  const app = buildApp();

  it("generates a correlation ID when none is supplied", async () => {
    const res = await request(app).get("/ping");
    expect(res.status).toBe(200);
    expect(res.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("propagates a valid inbound X-Correlation-Id header", async () => {
    const id = "trace-12345678-abcd";
    const res = await request(app)
      .get("/ping")
      .set(CORRELATION_ID_HEADER, id);
    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe(id);
    expect(res.headers["x-correlation-id"]).toBe(id);
  });

  it("ignores a too-short inbound correlation ID and generates a fresh one", async () => {
    const res = await request(app)
      .get("/ping")
      .set(CORRELATION_ID_HEADER, "short");
    expect(res.body.correlationId).not.toBe("short");
    expect(res.body.correlationId.length).toBeGreaterThanOrEqual(8);
  });

  it("ignores a too-long inbound correlation ID and generates a fresh one", async () => {
    const tooLong = "x".repeat(129);
    const res = await request(app)
      .get("/ping")
      .set(CORRELATION_ID_HEADER, tooLong);
    expect(res.body.correlationId).not.toBe(tooLong);
  });

  it("echoes correlation ID in response headers", async () => {
    const id = "echo-test-abcdef1234";
    const res = await request(app)
      .get("/ping")
      .set(CORRELATION_ID_HEADER, id);
    expect(res.headers["x-correlation-id"]).toBe(id);
  });

  it("always generates a unique per-hop request ID regardless of correlation ID", async () => {
    const res1 = await request(app).get("/ping");
    const res2 = await request(app).get("/ping");
    expect(res1.body.requestId).not.toBe(res2.body.requestId);
  });

  it("exposes both IDs in response headers", async () => {
    const res = await request(app).get("/ping");
    expect(res.headers["x-correlation-id"]).toBeDefined();
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("attaches IDs to req so downstream handlers can read them", async () => {
    const res = await request(app).get("/ping");
    expect(res.body.correlationId).toBeTruthy();
    expect(res.body.requestId).toBeTruthy();
  });
});
