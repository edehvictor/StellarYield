import request from "supertest";
import { createApp } from "../app";
import {
  stageAlertPreferenceOperation,
  executeAlertPreferenceOperation,
  resumeAlertPreferenceOperation,
  rollbackAlertPreferenceOperation,
  getAlertPreferenceOperation,
  clearAlertPreferenceOperationStore,
  validateAlertPreferencesInput,
  AlertPreferenceValidationError,
  AlertPreferenceConflictError,
} from "../services/alertPreferenceOperationService";
import {
  getAlertPreferences,
  setAlertPreferences,
  clearAlertPreferencesStore,
  clearAlertOperationStore,
} from "../services/alertsService";
import { resetAuditStore } from "../services/alertPreferenceAuditService";
import type { AlertPreferences } from "../services/alertsPreferenceRules";

describe("Alert Preference Operations - Resilience, Partial Completion & Safe Retry (#1907)", () => {
  const app = createApp();
  const WALLET = "GAALERTUSER11111111111111111111111111111111111111111111";
  const VAULT = "Blend-USDC";

  const VALID_PREFS: AlertPreferences = {
    channel: "email",
    cooldownMinutes: 60,
    severityThreshold: 5,
    quietHoursStart: 22,
    quietHoursEnd: 7,
  };

  const UPDATED_PREFS: AlertPreferences = {
    channel: "in_app",
    cooldownMinutes: 120,
    severityThreshold: 10,
    quietHoursStart: 23,
    quietHoursEnd: 6,
  };

  beforeEach(() => {
    clearAlertPreferencesStore();
    clearAlertOperationStore();
    clearAlertPreferenceOperationStore();
    resetAuditStore();
  });

  describe("Service Layer: Staging, Execution, Checkpointing & Rollback", () => {
    it("stages and executes an operation cleanly through all stages to succeeded", () => {
      const { operation, replayed } = stageAlertPreferenceOperation({
        operationId: "op-test-1",
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: VALID_PREFS,
      });

      expect(replayed).toBe(false);
      expect(operation.operationId).toBe("op-test-1");
      expect(operation.status).toBe("staged");
      expect(operation.stage).toBe("staging");
      expect(operation.previousPreferences).toBeNull();
      expect(operation.targetPreferences).toEqual(VALID_PREFS);

      // Execute
      const completed = executeAlertPreferenceOperation("op-test-1");
      expect(completed.status).toBe("succeeded");
      expect(completed.stage).toBe("completed");
      expect(completed.completedAt).toBeDefined();

      // State is active in preferences store
      const stored = getAlertPreferences(WALLET, VAULT);
      expect(stored).toEqual(VALID_PREFS);
    });

    it("preserves existing state and does not create an operation when boundary validation fails", () => {
      setAlertPreferences(WALLET, VAULT, VALID_PREFS);

      expect(() => {
        validateAlertPreferencesInput({
          channel: "sms", // Invalid channel
          cooldownMinutes: 60,
          severityThreshold: 5,
          quietHoursStart: 22,
          quietHoursEnd: 7,
        });
      }).toThrow(AlertPreferenceValidationError);

      expect(() => {
        stageAlertPreferenceOperation({
          operationId: "op-invalid",
          walletAddress: WALLET,
          vaultId: VAULT,
          preferences: {
            channel: "invalid" as any,
            cooldownMinutes: -10, // Invalid cooldown
            severityThreshold: 5,
            quietHoursStart: 22,
            quietHoursEnd: 7,
          },
        });
      }).toThrow(AlertPreferenceValidationError);

      // Original preferences remain completely untouched
      expect(getAlertPreferences(WALLET, VAULT)).toEqual(VALID_PREFS);
      expect(getAlertPreferenceOperation("op-invalid")).toBeUndefined();
    });

    it("captures previousPreferences snapshot and rolls back predictably on failure or request", () => {
      // 1. Initial configuration
      setAlertPreferences(WALLET, VAULT, VALID_PREFS);

      // 2. Stage new preferences
      const { operation } = stageAlertPreferenceOperation({
        operationId: "op-update-1",
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: UPDATED_PREFS,
      });

      expect(operation.previousPreferences).toEqual(VALID_PREFS);

      // 3. Apply
      executeAlertPreferenceOperation("op-update-1");
      expect(getAlertPreferences(WALLET, VAULT)).toEqual(UPDATED_PREFS);

      // 4. Rollback to checkpoint
      const { operation: rolledBack, preferences: restored } =
        rollbackAlertPreferenceOperation("op-update-1");

      expect(rolledBack.status).toBe("rolled_back");
      expect(restored).toEqual(VALID_PREFS);
      expect(getAlertPreferences(WALLET, VAULT)).toEqual(VALID_PREFS);
    });

    it("rolls back cleanly when initial preferences were null (clears store)", () => {
      const { operation } = stageAlertPreferenceOperation({
        operationId: "op-initial-1",
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: VALID_PREFS,
      });

      expect(operation.previousPreferences).toBeNull();
      executeAlertPreferenceOperation("op-initial-1");
      expect(getAlertPreferences(WALLET, VAULT)).toEqual(VALID_PREFS);

      rollbackAlertPreferenceOperation("op-initial-1");
      expect(getAlertPreferences(WALLET, VAULT)).toBeUndefined();
    });

    it("resumes an interrupted/failed operation safely from saved checkpoint", () => {
      const { operation } = stageAlertPreferenceOperation({
        operationId: "op-resume-1",
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: UPDATED_PREFS,
      });

      // Simulate partial failure at staging
      expect(operation.status).toBe("staged");

      // Resume operation
      const { operation: resumed, preferences } =
        resumeAlertPreferenceOperation("op-resume-1");

      expect(resumed.status).toBe("succeeded");
      expect(resumed.stage).toBe("completed");
      expect(preferences).toEqual(UPDATED_PREFS);
      expect(getAlertPreferences(WALLET, VAULT)).toEqual(UPDATED_PREFS);
    });

    it("replays existing result idempotently on safe retry of completed operation", () => {
      const { operation } = stageAlertPreferenceOperation({
        operationId: "op-retry-1",
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: VALID_PREFS,
      });
      executeAlertPreferenceOperation(operation.operationId);

      // Retry with identical parameters
      const retryResult = stageAlertPreferenceOperation({
        operationId: "op-retry-1",
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: VALID_PREFS,
      });

      expect(retryResult.replayed).toBe(true);
      expect(retryResult.operation.status).toBe("succeeded");
    });

    it("rejects duplicate operation identity when parameters conflict (409)", () => {
      stageAlertPreferenceOperation({
        operationId: "op-conflict-1",
        walletAddress: WALLET,
        vaultId: VAULT,
        preferences: VALID_PREFS,
      });

      expect(() => {
        stageAlertPreferenceOperation({
          operationId: "op-conflict-1",
          walletAddress: WALLET,
          vaultId: VAULT,
          preferences: UPDATED_PREFS, // Different parameters!
        });
      }).toThrow(AlertPreferenceConflictError);
    });
  });

  describe("API Endpoints: /api/alerts/preferences & /api/alerts/preferences/operations", () => {
    it("PUT /api/alerts/preferences creates preferences and supports safe retry", async () => {
      const opId = "op-api-1";
      const res1 = await request(app)
        .put("/api/alerts/preferences")
        .set("X-Operation-Identity", opId)
        .send({
          walletAddress: WALLET,
          vaultId: VAULT,
          preferences: VALID_PREFS,
        });

      expect(res1.status).toBe(200);
      expect(res1.body).toMatchObject(VALID_PREFS);
      expect(res1.headers["x-idempotent-replayed"]).toBeUndefined();

      // Retry
      const res2 = await request(app)
        .put("/api/alerts/preferences")
        .set("X-Operation-Identity", opId)
        .send({
          walletAddress: WALLET,
          vaultId: VAULT,
          preferences: VALID_PREFS,
        });

      expect(res2.status).toBe(200);
      expect(res2.headers["x-idempotent-replayed"]).toBe("true");
      expect(res2.body).toMatchObject(VALID_PREFS);
    });

    it("PUT /api/alerts/preferences returns 400 and preserves state when validation fails", async () => {
      setAlertPreferences(WALLET, VAULT, VALID_PREFS);

      const res = await request(app)
        .put("/api/alerts/preferences")
        .send({
          walletAddress: WALLET,
          vaultId: VAULT,
          preferences: {
            channel: "email",
            cooldownMinutes: 99999, // Out of bounds
            severityThreshold: 5,
            quietHoursStart: 22,
            quietHoursEnd: 7,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("cooldownMinutes");
      // State is preserved!
      expect(getAlertPreferences(WALLET, VAULT)).toEqual(VALID_PREFS);
    });

    it("POST /api/alerts/preferences/operations stages and executes with resume and rollback routes", async () => {
      const opId = "op-lifecycle-1";

      // 1. Stage without auto-executing
      const stageRes = await request(app)
        .post("/api/alerts/preferences/operations")
        .send({
          operationIdentity: opId,
          walletAddress: WALLET,
          vaultId: VAULT,
          preferences: VALID_PREFS,
          autoExecute: false,
        });

      expect(stageRes.status).toBe(201);
      expect(stageRes.body.operation.status).toBe("staged");

      // 2. Query operation state via GET
      const getRes = await request(app).get(
        `/api/alerts/preferences/operations/${opId}`,
      );
      expect(getRes.status).toBe(200);
      expect(getRes.body.operation.status).toBe("staged");

      // 3. Resume / Execute
      const resumeRes = await request(app).post(
        `/api/alerts/preferences/operations/${opId}/resume`,
      );
      expect(resumeRes.status).toBe(200);
      expect(resumeRes.body.operation.status).toBe("succeeded");
      expect(getAlertPreferences(WALLET, VAULT)).toEqual(VALID_PREFS);

      // 4. Rollback
      const rollbackRes = await request(app).post(
        `/api/alerts/preferences/operations/${opId}/rollback`,
      );
      expect(rollbackRes.status).toBe(200);
      expect(rollbackRes.body.operation.status).toBe("rolled_back");
      expect(getAlertPreferences(WALLET, VAULT)).toBeUndefined();
    });
  });
});
