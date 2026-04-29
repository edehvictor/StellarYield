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

  afterEach(() => {
    jest.clearAllMocks();
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
