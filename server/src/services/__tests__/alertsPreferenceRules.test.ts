import {
  shouldSuppressAlert,
  recommendAlertThreshold,
  normalizeAlertThresholdInputs,
  saveAlertThresholdRecommendation,
  getAlertThresholdRecommendation,
  getAlertThresholdRecommendationHistory,
  resetAlertThresholdRecommendationStore,
  ALERT_THRESHOLD_REASON_DESCRIPTIONS,
  type AlertThresholdRecommendationInput,
} from "../alertsPreferenceRules";

describe("alert preference suppression rules", () => {
  const prefs = {
    channel: "email" as const,
    cooldownMinutes: 60,
    severityThreshold: 5,
    quietHoursStart: 23,
    quietHoursEnd: 6,
  };

  it("suppresses during quiet hours", () => {
    const now = new Date("2026-05-26T23:30:00Z");
    expect(shouldSuppressAlert(now, undefined, prefs)).toBe(true);
  });

  it("suppresses while cooldown is active", () => {
    const now = new Date("2026-05-26T12:30:00Z");
    const previous = new Date("2026-05-26T12:00:00Z").getTime();
    expect(shouldSuppressAlert(now, previous, prefs)).toBe(true);
  });

  it("allows alerts outside quiet hours and after cooldown", () => {
    const now = new Date("2026-05-26T14:30:00Z");
    const previous = new Date("2026-05-26T12:00:00Z").getTime();
    expect(shouldSuppressAlert(now, previous, prefs)).toBe(false);
  });
});

describe("Deterministic Alert Threshold Recommendations", () => {
  beforeEach(() => {
    resetAlertThresholdRecommendationStore();
  });

  describe("Determinism across repeated runs", () => {
    it("should produce identical alert threshold recommendation for 100 identical runs", () => {
      const input: AlertThresholdRecommendationInput = {
        walletAddress: "GABC123",
        vaultId: "usdc-vault-1",
        historicalVolatility: 65.5,
        triggerFrequencyPerHour: 4.2,
        noiseIndex: 0.6,
        apyDispersion: 2.5,
        userQuietHoursSpan: 8,
      };

      const baseline = recommendAlertThreshold(input);

      for (let i = 0; i < 100; i++) {
        const current = recommendAlertThreshold(input);
        expect(current.recommendedSeverityThreshold).toBe(baseline.recommendedSeverityThreshold);
        expect(current.recommendedCooldownMinutes).toBe(baseline.recommendedCooldownMinutes);
        expect(current.primaryReasonCode).toBe(baseline.primaryReasonCode);
        expect(current.reasonCodes).toEqual(baseline.reasonCodes);
        expect(current.reason).toBe(baseline.reason);
      }
    });

    it("should produce baseline defaults under normal conditions", () => {
      const normalInput: AlertThresholdRecommendationInput = {
        historicalVolatility: 30,
        triggerFrequencyPerHour: 1.0,
        noiseIndex: 0.2,
        apyDispersion: 1.0,
      };

      const result = recommendAlertThreshold(normalInput);
      expect(result.recommendedSeverityThreshold).toBe(5.0);
      expect(result.recommendedCooldownMinutes).toBe(60);
      expect(result.primaryReasonCode).toBe("BASELINE_DEFAULT");
      expect(result.reasonCodes).toEqual(["BASELINE_DEFAULT"]);
    });
  });

  describe("Jittery input normalization", () => {
    it("should normalize floating point jitter to produce identical output", () => {
      const cleanInput: AlertThresholdRecommendationInput = {
        historicalVolatility: 70.0,
        triggerFrequencyPerHour: 3.0,
        noiseIndex: 0.4,
      };

      const jitteryInput: AlertThresholdRecommendationInput = {
        historicalVolatility: 70.00000000000001,
        triggerFrequencyPerHour: 3.0000000000000004,
        noiseIndex: 0.4000000000000001,
      };

      const cleanRec = recommendAlertThreshold(cleanInput);
      const jitteryRec = recommendAlertThreshold(jitteryInput);

      expect(jitteryRec.recommendedSeverityThreshold).toBe(cleanRec.recommendedSeverityThreshold);
      expect(jitteryRec.recommendedCooldownMinutes).toBe(cleanRec.recommendedCooldownMinutes);
      expect(jitteryRec.primaryReasonCode).toBe(cleanRec.primaryReasonCode);
      expect(jitteryRec.reasonCodes).toEqual(cleanRec.reasonCodes);
    });
  });

  describe("Boundary conditions and clamping", () => {
    it("should clamp out-of-range inputs safely", () => {
      const extremeInput: Partial<AlertThresholdRecommendationInput> = {
        historicalVolatility: 200,
        triggerFrequencyPerHour: -5,
        noiseIndex: 10,
        apyDispersion: -1,
        userQuietHoursSpan: 50,
      };

      const normalized = normalizeAlertThresholdInputs(extremeInput);
      expect(normalized.historicalVolatility).toBe(100);
      expect(normalized.triggerFrequencyPerHour).toBe(0);
      expect(normalized.noiseIndex).toBe(1);
      expect(normalized.apyDispersion).toBe(0);
      expect(normalized.userQuietHoursSpan).toBe(24);
    });

    it("should handle empty or partial inputs gracefully", () => {
      const rec = recommendAlertThreshold({});
      expect(rec.recommendedSeverityThreshold).toBeGreaterThanOrEqual(1.0);
      expect(rec.recommendedCooldownMinutes).toBeGreaterThanOrEqual(15);
      expect(rec.primaryReasonCode).toBeDefined();
    });

    it("should enforce minimum severity floor and maximum ceiling", () => {
      const lowRec = recommendAlertThreshold(
        { historicalVolatility: 0 },
        { defaultSeverityThreshold: 1.0, minSeverityThreshold: 1.0 },
      );
      expect(lowRec.recommendedSeverityThreshold).toBe(1.0);
      expect(lowRec.reasonCodes).toContain("MIN_SEVERITY_FLOOR");

      const highRec = recommendAlertThreshold(
        { historicalVolatility: 100, noiseIndex: 1.0 },
        { defaultSeverityThreshold: 20.0, maxSeverityThreshold: 22.0 },
      );
      expect(highRec.recommendedSeverityThreshold).toBe(22.0);
      expect(highRec.reasonCodes).toContain("MAX_SEVERITY_CEILING");
    });
  });

  describe("Reason codes and explanatory descriptions", () => {
    it("should assign HIGH_VOLATILITY_EXPANSION when volatility > 50", () => {
      const rec = recommendAlertThreshold({ historicalVolatility: 75 });
      expect(rec.reasonCodes).toContain("HIGH_VOLATILITY_EXPANSION");
      expect(rec.reason).toContain("High market volatility");
    });

    it("should assign LOW_VOLATILITY_TIGHTENING when volatility < 15", () => {
      const rec = recommendAlertThreshold({ historicalVolatility: 5 });
      expect(rec.reasonCodes).toContain("LOW_VOLATILITY_TIGHTENING");
      expect(rec.reason).toContain("Low volatility environment");
    });

    it("should assign BURST_TRIGGER_SUPPRESSION when frequency >= 3", () => {
      const rec = recommendAlertThreshold({ triggerFrequencyPerHour: 5 });
      expect(rec.reasonCodes).toContain("BURST_TRIGGER_SUPPRESSION");
      expect(rec.reason).toContain("Frequent trigger burst history");
    });

    it("should assign HIGH_NOISE_DAMPENING when noiseIndex > 0.5", () => {
      const rec = recommendAlertThreshold({ noiseIndex: 0.8 });
      expect(rec.reasonCodes).toContain("HIGH_NOISE_DAMPENING");
      expect(rec.reason).toContain("Noise dampening applied");
    });

    it("should assign QUIET_HOURS_BUFFER when quiet hours span >= 6", () => {
      const rec = recommendAlertThreshold({ userQuietHoursSpan: 8 });
      expect(rec.reasonCodes).toContain("QUIET_HOURS_BUFFER");
    });

    it("should have valid descriptions for all reason codes", () => {
      const rec = recommendAlertThreshold({ historicalVolatility: 80, triggerFrequencyPerHour: 5 });
      for (const code of rec.reasonCodes) {
        expect(ALERT_THRESHOLD_REASON_DESCRIPTIONS[code]).toBeDefined();
        expect(typeof ALERT_THRESHOLD_REASON_DESCRIPTIONS[code]).toBe("string");
      }
    });
  });

  describe("Persistence & History Store", () => {
    it("should persist and retrieve recommendations by wallet and vault", () => {
      const wallet = "GABCXYZ123";
      const vault = "xlm-vault";

      const rec = recommendAlertThreshold({
        walletAddress: wallet,
        vaultId: vault,
        historicalVolatility: 60,
      });

      const retrieved = getAlertThresholdRecommendation(wallet, vault);
      expect(retrieved).toBeDefined();
      expect(retrieved?.recommendedSeverityThreshold).toBe(rec.recommendedSeverityThreshold);
      expect(retrieved?.primaryReasonCode).toBe(rec.primaryReasonCode);

      const history = getAlertThresholdRecommendationHistory(wallet, vault);
      expect(history.length).toBe(1);
    });

    it("should clear history on reset", () => {
      const wallet = "GABCXYZ123";
      const vault = "xlm-vault";

      recommendAlertThreshold({ walletAddress: wallet, vaultId: vault, historicalVolatility: 60 });
      resetAlertThresholdRecommendationStore();

      expect(getAlertThresholdRecommendation(wallet, vault)).toBeUndefined();
      expect(getAlertThresholdRecommendationHistory(wallet, vault)).toEqual([]);
    });
  });
});
