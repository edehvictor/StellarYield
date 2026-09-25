import {
  evaluateHealthScoreChange,
  getAlertHistory,
  resetState,
  type HealthScoreChangeAlert,
} from "../services/healthScoreChangeAlertService";
import type { StrategyHealthScore } from "../services/strategyHealthService";

function makeScore(overrides: Partial<StrategyHealthScore> = {}): StrategyHealthScore {
  return {
    strategyId: "test-strategy",
    strategyName: "Test Strategy",
    overallScore: 80,
    metrics: {
      contractSafety: 0.9,
      dataFreshness: 0.85,
      providerUptime: 0.95,
      liquidityConditions: 0.8,
      executionOutcomes: 0.9,
      volatilityIndex: 0.3,
      errorRate: 0.02,
      latency: 200,
    },
    status: "healthy",
    signals: [],
    lastUpdated: new Date().toISOString(),
    trend: "stable",
    recommendations: [],
    ...overrides,
  };
}

describe("healthScoreChangeAlertService", () => {
  beforeEach(() => {
    resetState();
  });

  describe("evaluateHealthScoreChange", () => {
    it("returns null on first evaluation (no baseline)", () => {
      const alert = evaluateHealthScoreChange(makeScore());
      expect(alert).toBeNull();
    });

    it("returns null when score change is below threshold", () => {
      evaluateHealthScoreChange(makeScore({ overallScore: 80 }));
      const alert = evaluateHealthScoreChange(makeScore({ overallScore: 85 }));
      expect(alert).toBeNull();
    });

    it("returns alert when score drops significantly", () => {
      evaluateHealthScoreChange(makeScore({ overallScore: 85 }));
      const alert = evaluateHealthScoreChange(
        makeScore({
          overallScore: 70,
          status: "degraded",
        }),
      );

      expect(alert).not.toBeNull();
      expect(alert!.previousScore).toBe(85);
      expect(alert!.currentScore).toBe(70);
      expect(alert!.scoreDelta).toBe(-15);
      expect(alert!.previousStatus).toBe("healthy");
      expect(alert!.currentStatus).toBe("degraded");
    });

    it("returns alert when score improves significantly", () => {
      evaluateHealthScoreChange(makeScore({ overallScore: 50, status: "critical" }));
      const alert = evaluateHealthScoreChange(
        makeScore({
          overallScore: 70,
          status: "degraded",
        }),
      );

      expect(alert).not.toBeNull();
      expect(alert!.scoreDelta).toBe(20);
    });

    it("includes changed factors in the alert", () => {
      evaluateHealthScoreChange(
        makeScore({
          overallScore: 80,
          metrics: {
            contractSafety: 0.9,
            dataFreshness: 0.85,
            providerUptime: 0.95,
            liquidityConditions: 0.8,
            executionOutcomes: 0.9,
            volatilityIndex: 0.3,
            errorRate: 0.02,
            latency: 200,
          },
        }),
      );

      const alert = evaluateHealthScoreChange(
        makeScore({
          overallScore: 65,
          metrics: {
            contractSafety: 0.5, // Significant drop
            dataFreshness: 0.85,
            providerUptime: 0.95,
            liquidityConditions: 0.4, // Significant drop
            executionOutcomes: 0.9,
            volatilityIndex: 0.3,
            errorRate: 0.02,
            latency: 200,
          },
        }),
      );

      expect(alert).not.toBeNull();
      expect(alert!.changedFactors.length).toBeGreaterThan(0);

      const contractFactor = alert!.changedFactors.find(
        (f) => f.metric === "contractSafety",
      );
      expect(contractFactor).toBeDefined();
      expect(contractFactor!.significant).toBe(true);
      expect(contractFactor!.previousValue).toBe(0.9);
      expect(contractFactor!.currentValue).toBe(0.5);
    });

    it("respects cooldown period", () => {
      // First evaluation
      evaluateHealthScoreChange(makeScore({ overallScore: 85 }));

      // First significant change - should alert
      const alert1 = evaluateHealthScoreChange(makeScore({ overallScore: 65 }));
      expect(alert1).not.toBeNull();

      // Second significant change within cooldown - should not alert
      const alert2 = evaluateHealthScoreChange(makeScore({ overallScore: 45 }));
      expect(alert2).toBeNull();
    });
  });

  describe("getAlertHistory", () => {
    it("returns empty history initially", () => {
      expect(getAlertHistory()).toHaveLength(0);
    });

    it("stores alerts in history", () => {
      evaluateHealthScoreChange(makeScore({ overallScore: 85 }));
      evaluateHealthScoreChange(makeScore({ overallScore: 65 }));

      const history = getAlertHistory();
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].previousScore).toBe(85);
      expect(history[0].currentScore).toBe(65);
    });

    it("respects limit parameter", () => {
      // Generate multiple alerts (different strategies to avoid cooldown)
      for (let i = 0; i < 5; i++) {
        evaluateHealthScoreChange(
          makeScore({ strategyId: `s${i}`, overallScore: 85 }),
        );
        evaluateHealthScoreChange(
          makeScore({ strategyId: `s${i}`, overallScore: 65 }),
        );
      }

      const history = getAlertHistory(3);
      expect(history).toHaveLength(3);
    });
  });

  describe("resetState", () => {
    it("clears all state", () => {
      evaluateHealthScoreChange(makeScore({ overallScore: 85 }));
      evaluateHealthScoreChange(makeScore({ overallScore: 65 }));

      resetState();

      // After reset, first evaluation should return null (no baseline)
      const alert = evaluateHealthScoreChange(makeScore({ overallScore: 50 }));
      expect(alert).toBeNull();
      expect(getAlertHistory()).toHaveLength(0);
    });
  });
});
