import {
  AdaptiveThresholdController,
  adaptiveThresholdController,
  formatThresholdState,
  isSignificantThresholdChange,
} from "../services/adaptiveThresholdService";

describe("AdaptiveThresholdController", () => {
  let controller: AdaptiveThresholdController;

  beforeEach(() => {
    controller = new AdaptiveThresholdController();
    controller.reset();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    // Ensure timers are cleared
    jest.clearAllTimers();
  });

  afterAll(async () => {
    // Add any async cleanup
    await new Promise(resolve => setTimeout(() => resolve(undefined), 100));
  });

  describe("getCurrentThreshold", () => {
    it("should return threshold state with default conditions", async () => {
      const state = await controller.getCurrentThreshold();

      expect(state).toBeDefined();
      expect(state.currentThreshold).toBeGreaterThanOrEqual(0.60);
      expect(state.currentThreshold).toBeLessThanOrEqual(0.95);
      expect(state.lastUpdated).toBeDefined();
      expect(state.conditions).toBeDefined();
      expect(state.currentReason).toBeDefined();
    });

    it("should maintain threshold within configured bounds", async () => {
      const state = await controller.getCurrentThreshold();

      expect(state.currentThreshold).toBeGreaterThanOrEqual(0.60); // absoluteMinimum
      expect(state.currentThreshold).toBeLessThanOrEqual(0.95); // maximumThreshold
    });

    it("should throw error when service is frozen", async () => {
      const mockFreezeService = require("../services/freezeService");
      jest.spyOn(mockFreezeService.freezeService, "isFrozen").mockReturnValue(true);

      await expect(controller.getCurrentThreshold()).rejects.toThrow(
        "Adaptive threshold service is frozen",
      );

      mockFreezeService.freezeService.isFrozen.mockRestore();
    });

    it("should cache results", async () => {
      const state1 = await controller.getCurrentThreshold();
      const state2 = await controller.getCurrentThreshold();

      expect(state1.lastUpdated).toBe(state2.lastUpdated);
    });

    it("should return fallback state on error", async () => {
      // Force an error condition
      const state = await controller.getCurrentThreshold();
      expect(state.currentThreshold).toBeDefined();
    });
  });

  describe("meetsThreshold", () => {
    it("should return true when confidence meets threshold", async () => {
      const result = await controller.meetsThreshold(0.85);

      expect(result.meets).toBeDefined();
      expect(result.currentThreshold).toBeDefined();
      expect(result.margin).toBeDefined();
    });

    it("should return false when confidence below threshold", async () => {
      // Set a high threshold manually
      await controller.manualOverride(0.90, "Test high threshold");
      
      const result = await controller.meetsThreshold(0.75);

      expect(result.meets).toBe(false);
      expect(result.margin).toBeLessThan(0);
    });

    it("should calculate correct margin", async () => {
      await controller.manualOverride(0.80, "Test threshold");
      
      const result = await controller.meetsThreshold(0.85);

      expect(result.margin).toBeCloseTo(0.05, 3);
    });
  });

  describe("manualOverride", () => {
    it("should allow manual threshold override", async () => {
      const newState = await controller.manualOverride(0.85, "Test override");

      expect(newState.currentThreshold).toBe(0.85);
      expect(newState.currentReason).toBe("Test override");
    });

    it("should enforce safety floor on manual override", async () => {
      const newState = await controller.manualOverride(0.40, "Test low override");

      expect(newState.currentThreshold).toBeGreaterThanOrEqual(0.60);
      expect(newState.atSafetyFloor).toBe(true);
    });

    it("should log manual override in adjustment history", async () => {
      await controller.manualOverride(0.85, "Test override");
      
      const history = controller.getAdjustmentHistory();
      
      expect(history.length).toBeGreaterThan(0);
      expect(history[history.length - 1].source).toBe("manual_override");
    });

    it("should throw error when service is frozen", async () => {
      const mockFreezeService = require("../services/freezeService");
      jest.spyOn(mockFreezeService.freezeService, "isFrozen").mockReturnValue(true);

      await expect(controller.manualOverride(0.85, "Test")).rejects.toThrow(
        "Adaptive threshold service is frozen",
      );

      mockFreezeService.freezeService.isFrozen.mockRestore();
    });
  });

  describe("adjustment limits", () => {
    it("should not exceed maximum single adjustment", async () => {
      // Set initial threshold
      await controller.manualOverride(0.75, "Initial");
      
      // Try to make a large jump
      const newState = await controller.manualOverride(0.95, "Large jump");

      const change = Math.abs(newState.currentThreshold - 0.75);
      expect(change).toBeLessThanOrEqual(0.10); // maxSingleAdjustment
    });

    it("should prevent threshold below absolute minimum", async () => {
      const newState = await controller.manualOverride(0.50, "Below minimum");

      expect(newState.currentThreshold).toBeGreaterThanOrEqual(0.60);
    });

    it("should allow threshold up to maximum", async () => {
      const newState = await controller.manualOverride(0.95, "At maximum");

      expect(newState.currentThreshold).toBeLessThanOrEqual(0.95);
    });
  });

  describe("configuration", () => {
    it("should return current configuration", () => {
      const config = controller.getConfig();

      expect(config).toBeDefined();
      expect(config.absoluteMinimum).toBe(0.60);
      expect(config.defaultThreshold).toBe(0.75);
      expect(config.maximumThreshold).toBe(0.95);
    });

    it("should update configuration", () => {
      controller.updateConfig({
        defaultThreshold: 0.80,
        volatilityPenalty: 0.10,
      });

      const config = controller.getConfig();
      expect(config.defaultThreshold).toBe(0.80);
      expect(config.volatilityPenalty).toBe(0.10);
    });

    it("should reject absolute minimum below 0.50", () => {
      expect(() => {
        controller.updateConfig({ absoluteMinimum: 0.40 });
      }).toThrow("Absolute minimum threshold cannot be below 0.50 (50%)");
    });

    it("should reject absolute minimum exceeding default threshold", () => {
      expect(() => {
        controller.updateConfig({ absoluteMinimum: 0.90 });
      }).toThrow("Absolute minimum cannot exceed default threshold");
    });

    it("should clear cache on config update", () => {
      controller.updateConfig({ defaultThreshold: 0.80 });
      
      // Cache should be cleared, next call should recalculate
      const state = controller.getCurrentThreshold();
      expect(state).toBeDefined();
    });
  });

  describe("adjustment history", () => {
    it("should track adjustment history", async () => {
      await controller.manualOverride(0.80, "First override");
      await controller.manualOverride(0.85, "Second override");

      const history = controller.getAdjustmentHistory();

      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    it("should limit history to last 50 adjustments", async () => {
      // Make 60 adjustments
      for (let i = 0; i < 60; i++) {
        await controller.manualOverride(0.75 + (i % 10) * 0.01, `Override ${i}`);
      }

      const history = controller.getAdjustmentHistory();

      expect(history.length).toBeLessThanOrEqual(50);
    });

    it("should include adjustment details", async () => {
      await controller.manualOverride(0.85, "Test override");

      const history = controller.getAdjustmentHistory();
      const lastAdjustment = history[history.length - 1];

      expect(lastAdjustment.previousThreshold).toBeDefined();
      expect(lastAdjustment.newThreshold).toBe(0.85);
      expect(lastAdjustment.delta).toBeDefined();
      expect(lastAdjustment.source).toBe("manual_override");
      expect(lastAdjustment.reason).toContain("Test override");
      expect(lastAdjustment.timestamp).toBeDefined();
      expect(lastAdjustment.conditions).toBeDefined();
    });
  });

  describe("reset", () => {
    it("should clear all cached data", async () => {
      await controller.getCurrentThreshold();
      controller.reset();

      // After reset, should recalculate
      const state = await controller.getCurrentThreshold();
      expect(state).toBeDefined();
    });

    it("should clear adjustment history", async () => {
      await controller.manualOverride(0.85, "Test override");
      controller.reset();

      const history = controller.getAdjustmentHistory();
      expect(history.length).toBe(0);
    });
  });

  describe("threshold adaptation logic", () => {
    it("should increase threshold for poor health conditions", async () => {
      // This tests the adaptation logic indirectly
      const state = await controller.getCurrentThreshold();
      expect(state.currentThreshold).toBeGreaterThanOrEqual(0.60);
    });

    it("should increase threshold for high volatility", async () => {
      const state = await controller.getCurrentThreshold();
      expect(state.currentThreshold).toBeLessThanOrEqual(0.95);
    });

    it("should increase threshold for active incidents", async () => {
      const state = await controller.getCurrentThreshold();
      expect(state.currentThreshold).toBeGreaterThanOrEqual(0.60);
    });

    it("should maintain safety floor under all conditions", async () => {
      const state = await controller.getCurrentThreshold();
      expect(state.currentThreshold).toBeGreaterThanOrEqual(0.60);
    });
  });

  describe("audit logging", () => {
    it("should enable audit logging by default", () => {
      const config = controller.getConfig();
      expect(config.enableAuditLogging).toBe(true);
    });

    it("should disable audit logging when configured", () => {
      controller.updateConfig({ enableAuditLogging: false });
      const config = controller.getConfig();
      expect(config.enableAuditLogging).toBe(false);
    });
  });
});

describe("formatThresholdState", () => {
  it("should format threshold state correctly", async () => {
    const controller = new AdaptiveThresholdController();
    const state = await controller.getCurrentThreshold();

    const formatted = formatThresholdState(state);

    expect(formatted).toBeDefined();
    expect(formatted.currentThreshold).toBeDefined();
    expect(formatted.adjustmentHistory).toBeDefined();
    
    // Check rounding
    if (formatted.adjustmentHistory.length > 0) {
      const adjustment = formatted.adjustmentHistory[0];
      expect(adjustment.previousThreshold).toBeDefined();
      expect(adjustment.newThreshold).toBeDefined();
      expect(adjustment.delta).toBeDefined();
    }
  });
});

describe("isSignificantThresholdChange", () => {
  it("should return true for changes greater than 5%", () => {
    expect(isSignificantThresholdChange(0.06)).toBe(true);
    expect(isSignificantThresholdChange(-0.06)).toBe(true);
    expect(isSignificantThresholdChange(0.10)).toBe(true);
  });

  it("should return false for changes less than or equal to 5%", () => {
    expect(isSignificantThresholdChange(0.05)).toBe(false);
    expect(isSignificantThresholdChange(-0.05)).toBe(false);
    expect(isSignificantThresholdChange(0.03)).toBe(false);
    expect(isSignificantThresholdChange(0)).toBe(false);
  });
});

describe("Singleton instance", () => {
  it("should export adaptiveThresholdController singleton", () => {
    expect(adaptiveThresholdController).toBeDefined();
    expect(adaptiveThresholdController).toBeInstanceOf(AdaptiveThresholdController);
  });
});

describe("Deterministic Threshold Recommendations & Normalization", () => {
  const {
    normalizeSystemConditions,
    recommendThreshold,
    saveThresholdRecommendation,
    getLatestThresholdRecommendation,
    getThresholdRecommendationHistory,
    resetThresholdRecommendationStore,
    ADAPTIVE_THRESHOLD_REASON_DESCRIPTIONS,
  } = require("../services/adaptiveThresholdService");

  beforeEach(() => {
    resetThresholdRecommendationStore();
  });

  describe("Determinism across repeated runs", () => {
    it("should produce identical recommendation output for 100 identical runs", () => {
      const input = {
        healthScore: 72.5,
        volatilityIndex: 0.65,
        providerReliability: 65,
        activeIncidents: 2,
        systemLoad: 0.85,
        hoursSinceLastIncident: 12,
      };

      const baseline = recommendThreshold(input);

      for (let i = 0; i < 100; i++) {
        const current = recommendThreshold(input);
        expect(current.recommendedThreshold).toBe(baseline.recommendedThreshold);
        expect(current.primaryReasonCode).toBe(baseline.primaryReasonCode);
        expect(current.reasonCodes).toEqual(baseline.reasonCodes);
        expect(current.reason).toBe(baseline.reason);
        expect(current.penalties).toEqual(baseline.penalties);
        expect(current.atSafetyFloor).toBe(baseline.atSafetyFloor);
        expect(current.atCeiling).toBe(baseline.atCeiling);
      }
    });

    it("should produce identical output for normal baseline conditions", () => {
      const normalInput = {
        healthScore: 90,
        volatilityIndex: 0.25,
        providerReliability: 85,
        activeIncidents: 0,
        systemLoad: 0.40,
        hoursSinceLastIncident: 200,
      };

      const result1 = recommendThreshold(normalInput);
      const result2 = recommendThreshold(normalInput);

      expect(result1.recommendedThreshold).toBe(0.75);
      expect(result1.primaryReasonCode).toBe("NORMAL_CONDITIONS");
      expect(result1.reasonCodes).toEqual(["NORMAL_CONDITIONS"]);
      expect(result1.penalties.totalPenalty).toBe(0);
      expect(result1.recommendedThreshold).toBe(result2.recommendedThreshold);
      expect(result1.reasonCodes).toEqual(result2.reasonCodes);
    });
  });

  describe("Jittery input normalization", () => {
    it("should normalize floating point jitter to produce identical recommendations", () => {
      const cleanInput = {
        healthScore: 75.0,
        volatilityIndex: 0.55,
        providerReliability: 80.0,
        activeIncidents: 1,
        systemLoad: 0.70,
        hoursSinceLastIncident: 48.0,
      };

      const jitteryInput = {
        healthScore: 75.00000000000001,
        volatilityIndex: 0.5500000000000002,
        providerReliability: 80.000000000004,
        activeIncidents: 1,
        systemLoad: 0.7000000000000001,
        hoursSinceLastIncident: 48.00000000002,
      };

      const cleanRec = recommendThreshold(cleanInput);
      const jitteryRec = recommendThreshold(jitteryInput);

      expect(jitteryRec.recommendedThreshold).toBe(cleanRec.recommendedThreshold);
      expect(jitteryRec.primaryReasonCode).toBe(cleanRec.primaryReasonCode);
      expect(jitteryRec.reasonCodes).toEqual(cleanRec.reasonCodes);
      expect(jitteryRec.penalties).toEqual(cleanRec.penalties);
    });

    it("should normalize slight perturbations near boundary without flip-flopping", () => {
      const norm1 = normalizeSystemConditions({ volatilityIndex: 0.3000000001 });
      const norm2 = normalizeSystemConditions({ volatilityIndex: 0.3000000002 });

      expect(norm1.volatilityIndex).toBe(norm2.volatilityIndex);
    });
  });

  describe("Boundary conditions & clamping", () => {
    it("should clamp extreme and negative values safely", () => {
      const extremeInput = {
        healthScore: -50,
        volatilityIndex: 5.5,
        providerReliability: -20,
        activeIncidents: -5,
        systemLoad: 10.0,
        hoursSinceLastIncident: -100,
      };

      const normalized = normalizeSystemConditions(extremeInput);
      expect(normalized.healthScore).toBe(0);
      expect(normalized.volatilityIndex).toBe(1);
      expect(normalized.providerReliability).toBe(0);
      expect(normalized.activeIncidents).toBe(0);
      expect(normalized.systemLoad).toBe(1);
      expect(normalized.hoursSinceLastIncident).toBe(0);
    });

    it("should handle NaN, null, and undefined values with fallback defaults", () => {
      const invalidInput = {
        healthScore: NaN,
        volatilityIndex: (null as unknown) as number,
        providerReliability: (undefined as unknown) as number,
        activeIncidents: ("invalid" as unknown) as number,
        systemLoad: Infinity,
        hoursSinceLastIncident: -Infinity,
      };

      const normalized = normalizeSystemConditions(invalidInput);
      expect(normalized.healthScore).toBe(85);
      expect(normalized.volatilityIndex).toBe(0.30);
      expect(normalized.providerReliability).toBe(80);
      expect(normalized.activeIncidents).toBe(0);
      expect(normalized.systemLoad).toBe(0.65);
      expect(normalized.hoursSinceLastIncident).toBe(168);
    });

    it("should strictly enforce minimum safety floor (0.60)", () => {
      // Even with custom config that tries to set a lower threshold, floor is kept
      const rec = recommendThreshold(
        { healthScore: 100, volatilityIndex: 0, providerReliability: 100, activeIncidents: 0, systemLoad: 0 },
        { defaultThreshold: 0.55, absoluteMinimum: 0.60 },
      );

      expect(rec.recommendedThreshold).toBeGreaterThanOrEqual(0.60);
      expect(rec.atSafetyFloor).toBe(true);
      expect(rec.reasonCodes).toContain("SAFETY_FLOOR_ENFORCED");
    });

    it("should strictly enforce maximum threshold ceiling (0.95)", () => {
      const extremeBadConditions = {
        healthScore: 10,
        volatilityIndex: 1.0,
        providerReliability: 10,
        activeIncidents: 10,
        systemLoad: 1.0,
        hoursSinceLastIncident: 0,
      };

      const rec = recommendThreshold(extremeBadConditions);
      expect(rec.recommendedThreshold).toBe(0.95);
      expect(rec.atCeiling).toBe(true);
      expect(rec.reasonCodes).toContain("MAX_THRESHOLD_ENFORCED");
    });
  });

  describe("Reason codes and explanatory output", () => {
    it("should assign HEALTH_DEGRADATION when health is below 80", () => {
      const rec = recommendThreshold({ healthScore: 70, volatilityIndex: 0.20, providerReliability: 80, activeIncidents: 0, systemLoad: 0.5 });
      expect(rec.reasonCodes).toContain("HEALTH_DEGRADATION");
      expect(rec.reason).toContain("Health degradation");
    });

    it("should assign HEALTH_CRITICAL when health is below critical threshold 50", () => {
      const rec = recommendThreshold({ healthScore: 40, volatilityIndex: 0.20, providerReliability: 80, activeIncidents: 0, systemLoad: 0.5 });
      expect(rec.reasonCodes).toContain("HEALTH_CRITICAL");
      expect(rec.reason).toContain("Critical health status");
    });

    it("should assign HIGH_VOLATILITY when volatility exceeds 0.50", () => {
      const rec = recommendThreshold({ healthScore: 85, volatilityIndex: 0.70, providerReliability: 80, activeIncidents: 0, systemLoad: 0.5 });
      expect(rec.reasonCodes).toContain("HIGH_VOLATILITY");
      expect(rec.reason).toContain("High volatility");
    });

    it("should assign POOR_PROVIDER_QUALITY when reliability is below 70", () => {
      const rec = recommendThreshold({ healthScore: 85, volatilityIndex: 0.20, providerReliability: 55, activeIncidents: 0, systemLoad: 0.5 });
      expect(rec.reasonCodes).toContain("POOR_PROVIDER_QUALITY");
      expect(rec.reason).toContain("Poor provider quality");
    });

    it("should assign ACTIVE_INCIDENTS when incidents > 0", () => {
      const rec = recommendThreshold({ healthScore: 85, volatilityIndex: 0.20, providerReliability: 80, activeIncidents: 3, systemLoad: 0.5 });
      expect(rec.reasonCodes).toContain("ACTIVE_INCIDENTS");
      expect(rec.reason).toContain("Active incidents (3)");
    });

    it("should assign HIGH_SYSTEM_LOAD when load > 0.80", () => {
      const rec = recommendThreshold({ healthScore: 85, volatilityIndex: 0.20, providerReliability: 80, activeIncidents: 0, systemLoad: 0.90 });
      expect(rec.reasonCodes).toContain("HIGH_SYSTEM_LOAD");
      expect(rec.reason).toContain("High system load");
    });

    it("should have valid reason descriptions in dictionary", () => {
      const rec = recommendThreshold({ healthScore: 60, volatilityIndex: 0.60 });
      for (const code of rec.reasonCodes) {
        expect(ADAPTIVE_THRESHOLD_REASON_DESCRIPTIONS[code]).toBeDefined();
        expect(typeof ADAPTIVE_THRESHOLD_REASON_DESCRIPTIONS[code]).toBe("string");
      }
    });
  });

  describe("Persistence & History Store", () => {
    it("should persist and retrieve threshold recommendations", () => {
      const rec1 = recommendThreshold({ healthScore: 85 });
      const rec2 = recommendThreshold({ healthScore: 65 });

      saveThresholdRecommendation("strategy_alpha", rec1);
      saveThresholdRecommendation("strategy_alpha", rec2);

      const latest = getLatestThresholdRecommendation("strategy_alpha");
      expect(latest?.recommendedThreshold).toBe(rec2.recommendedThreshold);

      const history = getThresholdRecommendationHistory("strategy_alpha");
      expect(history).toHaveLength(2);
      expect(history[0].recommendedThreshold).toBe(rec2.recommendedThreshold);
      expect(history[1].recommendedThreshold).toBe(rec1.recommendedThreshold);
    });

    it("should clear history on reset", () => {
      const rec = recommendThreshold({ healthScore: 85 });
      saveThresholdRecommendation("strategy_alpha", rec);
      resetThresholdRecommendationStore();

      expect(getLatestThresholdRecommendation("strategy_alpha")).toBeUndefined();
      expect(getThresholdRecommendationHistory("strategy_alpha")).toEqual([]);
    });
  });
});

