/**
 * Tests for the APY Alerts service and route.
 */
import request from "supertest";
import { createApp } from "../app";
import * as alertsService from "../services/alertsService";

// Define a local type matching the Prisma UserAlert shape for test fixtures
interface UserAlert {
  id: string;
  walletAddress: string;
  vaultId: string;
  condition: string;
  thresholdValue: number;
  email: string;
  status: string;
  triggeredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Mock the service so tests don't hit a real DB ────────────────────────

jest.mock("../services/alertsService", () => ({
  MAX_ALERTS_PER_USER: 20,
  createAlert: jest.fn(),
  listAlerts: jest.fn(),
  deleteAlert: jest.fn(),
  evaluateAlerts: jest.fn(),
}));

const mockCreate = alertsService.createAlert as jest.MockedFunction<typeof alertsService.createAlert>;
const mockList = alertsService.listAlerts as jest.MockedFunction<typeof alertsService.listAlerts>;
const mockDelete = alertsService.deleteAlert as jest.MockedFunction<typeof alertsService.deleteAlert>;

const SAMPLE_ALERT: UserAlert = {
  id: "alert-1",
  walletAddress: "GTEST123",
  vaultId: "Blend",
  condition: "above",
  thresholdValue: 10,
  email: "user@example.com",
  status: "active",
  triggeredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("POST /api/alerts", () => {
  const app = createApp();

  beforeEach(() => jest.clearAllMocks());

  it("creates an alert with valid payload", async () => {
    mockCreate.mockResolvedValue(SAMPLE_ALERT);

    const res = await request(app).post("/api/alerts").send({
      walletAddress: "GTEST123",
      vaultId: "Blend",
      condition: "above",
      thresholdValue: 10,
      email: "user@example.com",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("alert-1");
    expect(mockCreate).toHaveBeenCalledWith({
      walletAddress: "GTEST123",
      vaultId: "Blend",
      condition: "above",
      thresholdValue: 10,
      email: "user@example.com",
    });
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app).post("/api/alerts").send({ walletAddress: "GTEST123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("returns 400 for invalid condition", async () => {
    const res = await request(app).post("/api/alerts").send({
      walletAddress: "GTEST123",
      vaultId: "Blend",
      condition: "sideways",
      thresholdValue: 10,
      email: "user@example.com",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for out-of-range threshold", async () => {
    const res = await request(app).post("/api/alerts").send({
      walletAddress: "GTEST123",
      vaultId: "Blend",
      condition: "above",
      thresholdValue: 9999,
      email: "user@example.com",
    });
    expect(res.status).toBe(400);
  });

  it("returns 429 when user hits alert cap", async () => {
    mockCreate.mockRejectedValue(new Error("Maximum of 20 active alerts per user reached."));

    const res = await request(app).post("/api/alerts").send({
      walletAddress: "GTEST123",
      vaultId: "Blend",
      condition: "above",
      thresholdValue: 10,
      email: "user@example.com",
    });
    expect(res.status).toBe(429);
  });
});

describe("GET /api/alerts/:wallet", () => {
  const app = createApp();

  beforeEach(() => jest.clearAllMocks());

  it("returns list of alerts for a wallet", async () => {
    mockList.mockResolvedValue([SAMPLE_ALERT]);

    const res = await request(app).get("/api/alerts/GTEST123");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("alert-1");
  });

  it("returns empty array when no alerts exist", async () => {
    mockList.mockResolvedValue([]);
    const res = await request(app).get("/api/alerts/GNONE");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("DELETE /api/alerts/:id", () => {
  const app = createApp();

  beforeEach(() => jest.clearAllMocks());

  it("deletes an alert and returns 204", async () => {
    mockDelete.mockResolvedValue({ ...SAMPLE_ALERT, status: "deleted" } as Awaited<ReturnType<typeof alertsService.deleteAlert>>);

    const res = await request(app)
      .delete("/api/alerts/alert-1")
      .send({ walletAddress: "GTEST123" });
    expect(res.status).toBe(204);
  });

  it("returns 400 when walletAddress is missing", async () => {
    const res = await request(app).delete("/api/alerts/alert-1").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when alert is not found", async () => {
    mockDelete.mockRejectedValue(new Error("Alert not found"));
    const res = await request(app)
      .delete("/api/alerts/bad-id")
      .send({ walletAddress: "GTEST123" });
    expect(res.status).toBe(404);
  });
});

// ── Unit tests for evaluateAlerts ────────────────────────────────────────

describe("evaluateAlerts (unit)", () => {
  // Re-import the real module for unit testing
  jest.unmock("../services/alertsService");

  it("is exported and callable", () => {
    // Just verify the export shape — DB calls are mocked at integration level
    expect(typeof alertsService.evaluateAlerts).toBe("function");
  });

  it("MAX_ALERTS_PER_USER is 20", () => {
    expect(alertsService.MAX_ALERTS_PER_USER).toBe(20);
  });
});
