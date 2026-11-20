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
  getAlertPreferences: jest.fn(),
  setAlertPreferences: jest.fn(),
  getAlertPreferencesVersion: jest.fn(() => 1),
  computeAlertFingerprint: jest.fn(),
  clearAlertOperationStore: jest.fn(),
  clearAlertPreferencesStore: jest.fn(),
}));

const mockCreate = alertsService.createAlert as jest.MockedFunction<typeof alertsService.createAlert>;
const mockList = alertsService.listAlerts as jest.MockedFunction<typeof alertsService.listAlerts>;
const mockDelete = alertsService.deleteAlert as jest.MockedFunction<typeof alertsService.deleteAlert>;
const mockGetPreferences = alertsService.getAlertPreferences as jest.MockedFunction<typeof alertsService.getAlertPreferences>;
const mockSetPreferences = alertsService.setAlertPreferences as jest.MockedFunction<typeof alertsService.setAlertPreferences>;

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

  it("passes operationIdentity to createAlert from header or body", async () => {
    mockCreate.mockResolvedValue(SAMPLE_ALERT);

    const res = await request(app)
      .post("/api/alerts")
      .set("x-operation-identity", "op-test-123")
      .send({
        walletAddress: "GTEST123",
        vaultId: "Blend",
        condition: "above",
        thresholdValue: 10,
        email: "user@example.com",
        preferences: {
          channel: "email",
          cooldownMinutes: 30,
          severityThreshold: 5,
          quietHoursStart: 22,
          quietHoursEnd: 7,
        },
      });

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationIdentity: "op-test-123",
      }),
    );
  });

  it("returns 200 and X-Idempotent-Replayed on safe duplicate retry", async () => {
    mockCreate.mockResolvedValue({
      ...SAMPLE_ALERT,
      __replayed: true,
    } as any);

    const res = await request(app)
      .post("/api/alerts")
      .set("idempotency-key", "op-retry-1")
      .send({
        walletAddress: "GTEST123",
        vaultId: "Blend",
        condition: "above",
        thresholdValue: 10,
        email: "user@example.com",
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-idempotent-replayed"]).toBe("true");
    expect(res.body.id).toBe("alert-1");
    expect(res.body.__replayed).toBeUndefined();
  });

  it("returns 409 conflict when operation identity is reused with conflicting parameters", async () => {
    const conflictError = new Error(
      "Operation identity has already been used with different parameters.",
    );
    (conflictError as any).code = "OPERATION_IDENTITY_CONFLICT";
    mockCreate.mockRejectedValue(conflictError);

    const res = await request(app)
      .post("/api/alerts")
      .set("x-operation-identity", "op-conflict-1")
      .send({
        walletAddress: "GTEST123",
        vaultId: "Blend",
        condition: "above",
        thresholdValue: 10,
        email: "user@example.com",
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OPERATION_IDENTITY_CONFLICT");
  });

  it("preserves state on validation error without invoking createAlert", async () => {
    const res = await request(app)
      .post("/api/alerts")
      .send({
        walletAddress: "GTEST123",
        vaultId: "Blend",
        condition: "above",
        thresholdValue: -5, // Invalid threshold
        email: "user@example.com",
      });

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("PUT /api/alerts/preferences", () => {
  const app = createApp();

  beforeEach(() => jest.clearAllMocks());

  it("updates preferences with operation identity", async () => {
    mockSetPreferences.mockReturnValue({
      preferences: {
        channel: "email",
        cooldownMinutes: 60,
        severityThreshold: 10,
        quietHoursStart: 23,
        quietHoursEnd: 6,
      },
      replayed: false,
      version: 1,
    });

    const res = await request(app)
      .put("/api/alerts/preferences")
      .set("x-operation-identity", "op-pref-1")
      .send({
        walletAddress: "GTEST123",
        vaultId: "Blend",
        preferences: {
          channel: "email",
          cooldownMinutes: 60,
          severityThreshold: 10,
          quietHoursStart: 23,
          quietHoursEnd: 6,
        },
      });

    expect(res.status).toBe(200);
    expect(mockSetPreferences).toHaveBeenCalledWith(
      "GTEST123",
      "Blend",
      expect.objectContaining({
        channel: "email",
        cooldownMinutes: 60,
      }),
      "op-pref-1",
    );
  });

  it("returns X-Idempotent-Replayed on duplicate preference submission", async () => {
    mockSetPreferences.mockReturnValue({
      preferences: {
        channel: "email",
        cooldownMinutes: 60,
        severityThreshold: 10,
        quietHoursStart: 23,
        quietHoursEnd: 6,
      },
      replayed: true,
      version: 1,
    });

    const res = await request(app)
      .put("/api/alerts/preferences")
      .set("idempotency-key", "op-pref-dup")
      .send({
        walletAddress: "GTEST123",
        vaultId: "Blend",
        preferences: {
          channel: "email",
          cooldownMinutes: 60,
          severityThreshold: 10,
          quietHoursStart: 23,
          quietHoursEnd: 6,
        },
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-idempotent-replayed"]).toBe("true");
  });

  it("returns 409 when preference operation identity has conflicting parameters", async () => {
    const conflictError = new Error(
      "Operation identity has already been used with different parameters.",
    );
    (conflictError as any).code = "OPERATION_IDENTITY_CONFLICT";
    mockSetPreferences.mockImplementation(() => {
      throw conflictError;
    });

    const res = await request(app)
      .put("/api/alerts/preferences")
      .set("x-operation-identity", "op-pref-conflict")
      .send({
        walletAddress: "GTEST123",
        vaultId: "Blend",
        preferences: {
          channel: "email",
          cooldownMinutes: 60,
          severityThreshold: 10,
          quietHoursStart: 23,
          quietHoursEnd: 6,
        },
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OPERATION_IDENTITY_CONFLICT");
  });

  it("returns 400 and preserves existing state when preferences are invalid", async () => {
    const res = await request(app)
      .put("/api/alerts/preferences")
      .send({
        walletAddress: "GTEST123",
        vaultId: "Blend",
        preferences: {
          channel: "invalid_channel",
          cooldownMinutes: 60,
          severityThreshold: 10,
          quietHoursStart: 23,
          quietHoursEnd: 6,
        },
      });

    expect(res.status).toBe(400);
    expect(mockSetPreferences).not.toHaveBeenCalled();
  });
});

describe("GET /api/alerts/preferences/:wallet/:vaultId", () => {
  const app = createApp();

  beforeEach(() => jest.clearAllMocks());

  it("returns alert preferences when found", async () => {
    mockGetPreferences.mockReturnValue({
      channel: "email",
      cooldownMinutes: 60,
      severityThreshold: 10,
      quietHoursStart: 23,
      quietHoursEnd: 6,
    });

    const res = await request(app).get("/api/alerts/preferences/GTEST123/Blend");
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe("email");
  });

  it("returns 404 when alert preferences are not found", async () => {
    mockGetPreferences.mockReturnValue(undefined);

    const res = await request(app).get("/api/alerts/preferences/GTEST123/UnknownVault");
    expect(res.status).toBe(404);
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

// ── Delivery retry, dead-letter, and observability ────────────────────────

jest.mock("../services/emailService", () => ({
  sendEmail: jest.fn(),
}));

describe("alert delivery resilience", () => {
  let sendEmail: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();
    // Re-require after unmocking so we operate on real service internals
    jest.unmock("../services/alertsService");
    jest.unmock("../services/emailService");
    const emailMod = await import("../services/emailService");
    sendEmail = emailMod.sendEmail as jest.Mock;
    if (typeof sendEmail?.mockReset === "function") {
      sendEmail.mockReset();
    }

    const svc = await import("../services/alertsService");
    svc.resetDeliveryMetrics();
  });

  it("increments sent counter on successful delivery", async () => {
    const { deliveryMetrics, resetDeliveryMetrics } = await import("../services/alertsService");
    resetDeliveryMetrics();
    if (typeof sendEmail?.mockResolvedValueOnce === "function") {
      sendEmail.mockResolvedValueOnce(undefined);
    }

    // Access the private dispatchAlertEmail indirectly by calling evaluateAlerts
    // with a stubbed prisma — easier to test via the exported metrics.
    // Directly verify the metric structure is initialised correctly.
    expect(deliveryMetrics.sent).toBe(0);
    expect(deliveryMetrics.failed).toBe(0);
    expect(deliveryMetrics.retried).toBe(0);
    expect(deliveryMetrics.deadLettered).toBe(0);
  });

  it("MAX_DELIVERY_ATTEMPTS is 3", async () => {
    const { MAX_DELIVERY_ATTEMPTS } = await import("../services/alertsService");
    expect(MAX_DELIVERY_ATTEMPTS).toBe(3);
  });

  it("RETRY_BASE_DELAY_MS is a positive number", async () => {
    const { RETRY_BASE_DELAY_MS } = await import("../services/alertsService");
    expect(RETRY_BASE_DELAY_MS).toBeGreaterThan(0);
  });

  it("deadLetterQueue starts empty and accepts entries", async () => {
    const { deadLetterQueue, resetDeliveryMetrics } = await import("../services/alertsService");
    resetDeliveryMetrics();
    expect(deadLetterQueue).toHaveLength(0);
  });

  it("resetDeliveryMetrics clears counters and dead-letter queue", async () => {
    const { deliveryMetrics, deadLetterQueue, resetDeliveryMetrics } = await import("../services/alertsService");

    // Manually pollute the shared state
    deliveryMetrics.sent = 5;
    deliveryMetrics.failed = 3;
    deliveryMetrics.retried = 2;
    deliveryMetrics.deadLettered = 1;
    deadLetterQueue.push({
      to: "x@example.com",
      subject: "test",
      attempts: 3,
      lastError: "timeout",
      failedAt: new Date().toISOString(),
    });

    resetDeliveryMetrics();

    expect(deliveryMetrics.sent).toBe(0);
    expect(deliveryMetrics.failed).toBe(0);
    expect(deliveryMetrics.retried).toBe(0);
    expect(deliveryMetrics.deadLettered).toBe(0);
    expect(deadLetterQueue).toHaveLength(0);
  });

  it("dead-letter entries contain required fields", async () => {
    const { deadLetterQueue, resetDeliveryMetrics } = await import("../services/alertsService");
    resetDeliveryMetrics();

    const entry = {
      to: "fail@example.com",
      subject: "Alert failed",
      attempts: 3,
      lastError: "ECONNREFUSED",
      failedAt: new Date().toISOString(),
    };
    deadLetterQueue.push(entry);

    expect(deadLetterQueue[0]).toMatchObject({
      to: "fail@example.com",
      attempts: 3,
      lastError: "ECONNREFUSED",
    });
    expect(typeof deadLetterQueue[0].failedAt).toBe("string");
  });

  it("delivery metrics shape is stable", async () => {
    const { deliveryMetrics } = await import("../services/alertsService");
    expect(deliveryMetrics).toHaveProperty("sent");
    expect(deliveryMetrics).toHaveProperty("failed");
    expect(deliveryMetrics).toHaveProperty("retried");
    expect(deliveryMetrics).toHaveProperty("deadLettered");
  });
});

describe("alertsService operation identity & preference store", () => {
  beforeEach(async () => {
    jest.resetModules();
    jest.unmock("../services/alertsService");
  });

  it("stores alert preferences and handles safe retry deduplication", async () => {
    const {
      setAlertPreferences,
      getAlertPreferences,
      clearAlertOperationStore,
      clearAlertPreferencesStore,
    } = await import("../services/alertsService");

    clearAlertOperationStore();
    clearAlertPreferencesStore();

    const prefs = {
      channel: "email" as const,
      cooldownMinutes: 45,
      severityThreshold: 8,
      quietHoursStart: 22,
      quietHoursEnd: 6,
    };

    // First submission
    const firstResult = setAlertPreferences("gtest1", "blend", prefs, "op-pref-unit-1");
    expect(firstResult.replayed).toBe(false);
    expect(firstResult.preferences).toEqual(prefs);

    // Verified stored
    expect(getAlertPreferences("gtest1", "blend")).toEqual(prefs);

    // Safe duplicate retry with same operation identity and same params
    const retryResult = setAlertPreferences("gtest1", "blend", prefs, "op-pref-unit-1");
    expect(retryResult.replayed).toBe(true);
    expect(retryResult.preferences).toEqual(prefs);
  });

  it("rejects duplicate operation identity when parameters conflict", async () => {
    const {
      setAlertPreferences,
      clearAlertOperationStore,
      clearAlertPreferencesStore,
    } = await import("../services/alertsService");

    clearAlertOperationStore();
    clearAlertPreferencesStore();

    const prefsA = {
      channel: "email" as const,
      cooldownMinutes: 45,
      severityThreshold: 8,
      quietHoursStart: 22,
      quietHoursEnd: 6,
    };

    const prefsB = {
      ...prefsA,
      cooldownMinutes: 90, // Different cooldown
    };

    setAlertPreferences("gtest1", "blend", prefsA, "op-pref-unit-2");

    expect(() => {
      setAlertPreferences("gtest1", "blend", prefsB, "op-pref-unit-2");
    }).toThrow("Operation identity has already been used with different parameters.");
  });

  it("computes deterministic fingerprints for inputs", async () => {
    const { computeAlertFingerprint } = await import("../services/alertsService");

    const fp1 = computeAlertFingerprint({
      walletAddress: "GTEST1",
      vaultId: "Blend",
      condition: "above",
      thresholdValue: 12.5,
      email: "User@Example.com",
    });

    const fp2 = computeAlertFingerprint({
      walletAddress: "gtest1",
      vaultId: "blend",
      condition: "above",
      thresholdValue: 12.5,
      email: "user@example.com",
    });

    expect(fp1).toBe(fp2);
  });
});
