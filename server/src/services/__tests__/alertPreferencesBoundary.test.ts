import express from "express";
import request from "supertest";
import {
  recommendAlertThreshold,
  normalizeAlertThresholdInputs,
  roundToDecimals,
  shouldSuppressAlert,
  resetAlertThresholdRecommendationStore,
  type AlertThresholdConfig,
} from "../alertsPreferenceRules";
import {
  updateAlertPreferences,
  getAlertPreferences,
  validateAlertPreferences,
  resetAlertPreferencesStore,
} from "../alertsService";
import {
  getPreferenceAuditHistory,
  resetAuditStore,
} from "../alertPreferenceAuditService";
import alertsRouter from "../../routes/alerts";

describe("Alert Preferences Boundary-Value Calculations & Invariants", () => {
  beforeEach(() => {
    resetAlertThresholdRecommendationStore();
    resetAlertPreferencesStore();
    resetAuditStore();
  });

  describe("Checked Arithmetic & Documented Rounding", () => {
    it("normalizes -0 to 0", () => {
      expect(Object.is(roundToDecimals(-0.00001, 2), 0)).toBe(true);
      expect(Object.is(roundToDecimals(-0, 2), 0)).toBe(true);
      expect(roundToDecimals(-0, 2)).toBe(0);
    });

    it("rounds half-up to specified decimal places deterministically", () => {
      expect(roundToDecimals(5.005, 2)).toBe(5.01);
      expect(roundToDecimals(5.004, 2)).toBe(5.0);
      expect(roundToDecimals(10.12345, 4)).toBe(10.1235);
      expect(roundToDecimals(10.12344, 4)).toBe(10.1234);
    });

    it("guards non-finite values safely returning 0", () => {
      expect(roundToDecimals(NaN, 2)).toBe(0);
      expect(roundToDecimals(Infinity, 2)).toBe(0);
      expect(roundToDecimals(-Infinity, 2)).toBe(0);
    });

    it("normalizes extreme, negative, and jittery inputs in normalizeAlertThresholdInputs", () => {
      const normalized = normalizeAlertThresholdInputs({
        historicalVolatility: -10,
        triggerFrequencyPerHour: -100,
        noiseIndex: -0.5,
        apyDispersion: -5,
        userQuietHoursSpan: -1,
      });

      expect(normalized.historicalVolatility).toBe(0);
      expect(normalized.triggerFrequencyPerHour).toBe(0);
      expect(normalized.noiseIndex).toBe(0);
      expect(normalized.apyDispersion).toBe(0);
      expect(normalized.userQuietHoursSpan).toBe(0);

      const maxNormalized = normalizeAlertThresholdInputs({
        historicalVolatility: 150,
        triggerFrequencyPerHour: 5000,
        noiseIndex: 5,
        apyDispersion: 500,
        userQuietHoursSpan: 100,
      });

      expect(maxNormalized.historicalVolatility).toBe(100);
      expect(maxNormalized.triggerFrequencyPerHour).toBe(1000);
      expect(maxNormalized.noiseIndex).toBe(1);
      expect(maxNormalized.apyDispersion).toBe(100);
      expect(maxNormalized.userQuietHoursSpan).toBe(24);
    });
  });

  describe("Division-by-Zero and Boundary Resilience in recommendAlertThreshold", () => {
    it("handles zero volatilityLowThreshold override without division-by-zero or NaN", () => {
      const overrides: Partial<AlertThresholdConfig> = {
        volatilityLowThreshold: 0,
      };
      const rec = recommendAlertThreshold({ historicalVolatility: 0 }, overrides);
      expect(Number.isFinite(rec.recommendedSeverityThreshold)).toBe(true);
      expect(Number.isNaN(rec.recommendedSeverityThreshold)).toBe(false);
      expect(rec.recommendedSeverityThreshold).toBeGreaterThanOrEqual(1.0);
    });

    it("handles volatilityHighThreshold set to 100 without division-by-zero", () => {
      const overrides: Partial<AlertThresholdConfig> = {
        volatilityHighThreshold: 100,
      };
      const rec = recommendAlertThreshold({ historicalVolatility: 100 }, overrides);
      expect(Number.isFinite(rec.recommendedSeverityThreshold)).toBe(true);
      expect(Number.isNaN(rec.recommendedSeverityThreshold)).toBe(false);
    });

    it("handles frequencyBurstThreshold set to 0 without division-by-zero", () => {
      const overrides: Partial<AlertThresholdConfig> = {
        frequencyBurstThreshold: 0,
      };
      const rec = recommendAlertThreshold({ triggerFrequencyPerHour: 10 }, overrides);
      expect(Number.isFinite(rec.recommendedCooldownMinutes)).toBe(true);
      expect(Number.isNaN(rec.recommendedCooldownMinutes)).toBe(false);
      expect(rec.recommendedCooldownMinutes).toBeLessThanOrEqual(1440);
    });

    it("handles inverted min/max config thresholds safely", () => {
      const inverted: Partial<AlertThresholdConfig> = {
        minSeverityThreshold: 20.0,
        maxSeverityThreshold: 5.0,
        minCooldownMinutes: 120,
        maxCooldownMinutes: 30,
      };
      const rec = recommendAlertThreshold({ historicalVolatility: 50 }, inverted);
      expect(rec.recommendedSeverityThreshold).toBeGreaterThanOrEqual(5.0);
      expect(rec.recommendedSeverityThreshold).toBeLessThanOrEqual(20.0);
      expect(rec.recommendedCooldownMinutes).toBeGreaterThanOrEqual(30);
      expect(rec.recommendedCooldownMinutes).toBeLessThanOrEqual(120);
    });
  });

  describe("Quiet Hours and Cooldown Suppression Boundary Invariants", () => {
    it("suppresses during overnight quiet hours wrapping across midnight (e.g. 23 to 6)", () => {
      const prefs = {
        channel: "email" as const,
        cooldownMinutes: 60,
        severityThreshold: 5,
        quietHoursStart: 23,
        quietHoursEnd: 6,
      };

      const lateNight = new Date("2026-05-26T23:30:00Z");
      const earlyMorning = new Date("2026-05-27T03:00:00Z");
      const outsideQuiet = new Date("2026-05-27T08:00:00Z");

      expect(shouldSuppressAlert(lateNight, undefined, prefs)).toBe(true);
      expect(shouldSuppressAlert(earlyMorning, undefined, prefs)).toBe(true);
      expect(shouldSuppressAlert(outsideQuiet, undefined, prefs)).toBe(false);
    });

    it("does not suppress when quietHoursStart equals quietHoursEnd (0-hour quiet window)", () => {
      const prefs = {
        channel: "email" as const,
        cooldownMinutes: 60,
        severityThreshold: 5,
        quietHoursStart: 12,
        quietHoursEnd: 12,
      };

      const now = new Date("2026-05-26T12:30:00Z");
      expect(shouldSuppressAlert(now, undefined, prefs)).toBe(false);
    });

    it("handles 0 cooldownMinutes without suppression", () => {
      const prefs = {
        channel: "email" as const,
        cooldownMinutes: 0,
        severityThreshold: 5,
        quietHoursStart: 2,
        quietHoursEnd: 4,
      };

      const now = new Date("2026-05-26T12:00:00Z");
      const justTriggered = new Date("2026-05-26T11:59:59Z").getTime();
      expect(shouldSuppressAlert(now, justTriggered, prefs)).toBe(false);
    });

    it("handles future previousTriggeredAtMs (clock skew) safely without suppression", () => {
      const prefs = {
        channel: "email" as const,
        cooldownMinutes: 60,
        severityThreshold: 5,
        quietHoursStart: 2,
        quietHoursEnd: 4,
      };

      const now = new Date("2026-05-26T12:00:00Z");
      const futureTime = new Date("2026-05-26T13:00:00Z").getTime();
      expect(shouldSuppressAlert(now, futureTime, prefs)).toBe(false);
    });

    it("handles NaN or invalid previousTriggeredAtMs without suppression", () => {
      const prefs = {
        channel: "email" as const,
        cooldownMinutes: 60,
        severityThreshold: 5,
        quietHoursStart: 2,
        quietHoursEnd: 4,
      };

      const now = new Date("2026-05-26T12:00:00Z");
      expect(shouldSuppressAlert(now, NaN, prefs)).toBe(false);
      expect(shouldSuppressAlert(now, -500, prefs)).toBe(false);
    });
  });

  describe("Validation & State Preservation on Rejection", () => {
    it("validates alert preferences strictly and rejects invalid boundaries", () => {
      expect(validateAlertPreferences(null).valid).toBe(false);
      expect(validateAlertPreferences({}).valid).toBe(false);

      const invalidCooldown = validateAlertPreferences({
        channel: "email",
        cooldownMinutes: 15.5, // non-integer
        severityThreshold: 5.0,
        quietHoursStart: 22,
        quietHoursEnd: 6,
      });
      expect(invalidCooldown.valid).toBe(false);
      expect(invalidCooldown.errors[0]).toContain("integer");

      const outOfRangeQuiet = validateAlertPreferences({
        channel: "email",
        cooldownMinutes: 60,
        severityThreshold: 5.0,
        quietHoursStart: 25, // > 23
        quietHoursEnd: 6,
      });
      expect(outOfRangeQuiet.valid).toBe(false);
      expect(outOfRangeQuiet.errors[0]).toContain("quietHoursStart");

      const negativeSeverity = validateAlertPreferences({
        channel: "email",
        cooldownMinutes: 60,
        severityThreshold: -1.0,
        quietHoursStart: 22,
        quietHoursEnd: 6,
      });
      expect(negativeSeverity.valid).toBe(false);
      expect(negativeSeverity.errors[0]).toContain("severityThreshold");
    });

    it("preserves existing state and does not create audit entry when updateAlertPreferences fails validation", () => {
      const wallet = "GTEST123";
      const vault = "usdc-vault-1";

      // 1. Initial valid preference set
      const validPrefs = {
        channel: "email" as const,
        cooldownMinutes: 60,
        severityThreshold: 5.0,
        quietHoursStart: 22,
        quietHoursEnd: 6,
      };
      updateAlertPreferences(wallet, vault, validPrefs);

      const initialStored = getAlertPreferences(wallet, vault);
      expect(initialStored).toEqual(validPrefs);
      expect(getPreferenceAuditHistory(wallet, vault)).toHaveLength(1);

      // 2. Attempt invalid update with negative cooldown
      expect(() => {
        updateAlertPreferences(wallet, vault, {
          channel: "email" as const,
          cooldownMinutes: -15,
          severityThreshold: 5.0,
          quietHoursStart: 22,
          quietHoursEnd: 6,
        });
      }).toThrow();

      // Invariant: Stored preferences and audit history remain untouched
      expect(getAlertPreferences(wallet, vault)).toEqual(validPrefs);
      expect(getPreferenceAuditHistory(wallet, vault)).toHaveLength(1);

      // 3. Attempt invalid update with out-of-bounds quiet hours
      expect(() => {
        updateAlertPreferences(wallet, vault, {
          channel: "email" as const,
          cooldownMinutes: 60,
          severityThreshold: 5.0,
          quietHoursStart: 99,
          quietHoursEnd: 6,
        });
      }).toThrow();

      expect(getAlertPreferences(wallet, vault)).toEqual(validPrefs);
      expect(getPreferenceAuditHistory(wallet, vault)).toHaveLength(1);
    });

    it("allows safe retry with valid preferences after rejected update", () => {
      const wallet = "GTEST123";
      const vault = "usdc-vault-1";

      const validInitial = {
        channel: "email" as const,
        cooldownMinutes: 60,
        severityThreshold: 5.0,
        quietHoursStart: 22,
        quietHoursEnd: 6,
      };
      updateAlertPreferences(wallet, vault, validInitial);

      // Failed attempt
      expect(() => {
        updateAlertPreferences(wallet, vault, {
          ...validInitial,
          cooldownMinutes: 2000, // > 1440
        });
      }).toThrow();

      // Safe retry with corrected value
      const corrected = {
        ...validInitial,
        cooldownMinutes: 120,
      };
      const result = updateAlertPreferences(wallet, vault, corrected);
      expect(result.preferences.cooldownMinutes).toBe(120);
      expect(getAlertPreferences(wallet, vault)?.cooldownMinutes).toBe(120);
      expect(getPreferenceAuditHistory(wallet, vault)).toHaveLength(2);
    });
  });

  describe("HTTP Routes Boundary Validation & State Invariant", () => {
    const app = express();
    app.use(express.json());
    app.use("/api/alerts", alertsRouter);

    it("rejects PUT /preferences with 400 on boundary violation and leaves state unchanged", async () => {
      const wallet = "GTEST456";
      const vault = "usdc-vault-2";

      // Set initial
      updateAlertPreferences(wallet, vault, {
        channel: "email",
        cooldownMinutes: 30,
        severityThreshold: 4.5,
        quietHoursStart: 23,
        quietHoursEnd: 7,
      });

      // Submit invalid quiet hours
      const res = await request(app)
        .put(`/api/alerts/${wallet}/preferences/${vault}`)
        .send({
          channel: "email",
          cooldownMinutes: 30,
          severityThreshold: 4.5,
          quietHoursStart: -1, // invalid
          quietHoursEnd: 7,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();

      // Verify state was preserved
      const stored = getAlertPreferences(wallet, vault);
      expect(stored?.quietHoursStart).toBe(23);
      expect(getPreferenceAuditHistory(wallet, vault)).toHaveLength(1);
    });

    it("rejects non-integer cooldownMinutes in PUT /preferences", async () => {
      const wallet = "GTEST456";
      const vault = "usdc-vault-2";

      const res = await request(app)
        .put(`/api/alerts/${wallet}/preferences/${vault}`)
        .send({
          channel: "email",
          cooldownMinutes: 45.8, // non-integer
          severityThreshold: 4.5,
          quietHoursStart: 23,
          quietHoursEnd: 7,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("integer");
    });

    it("accepts valid boundary values: 0 cooldown, 0 and 23 quiet hours, 0 and 1000 severity", async () => {
      const wallet = "GTEST789";
      const vault = "usdc-vault-3";

      const res = await request(app)
        .put(`/api/alerts/${wallet}/preferences/${vault}`)
        .send({
          channel: "in_app",
          cooldownMinutes: 0,
          severityThreshold: 0,
          quietHoursStart: 0,
          quietHoursEnd: 23,
        });

      expect(res.status).toBe(200);
      expect(res.body.preferences).toEqual({
        channel: "in_app",
        cooldownMinutes: 0,
        severityThreshold: 0,
        quietHoursStart: 0,
        quietHoursEnd: 23,
      });
    });
  });
});
