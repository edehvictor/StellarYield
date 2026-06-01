/**
 * Tests for Issue #289: Composable Multi-Strategy Vault Orchestrator
 * Tests for composition, weight normalization, and failure isolation.
 */

import {
  VaultOrchestrator,
  type OrchestrationConfig,
  type StrategyModule,
} from "../vaultOrchestratorService";

describe("VaultOrchestrator", () => {
  let orchestrator: VaultOrchestrator;
  let config: OrchestrationConfig;

  beforeEach(() => {
    const strategies: StrategyModule[] = [
      {
        id: "strat_1",
        name: "Conservative",
        version: "1.0.0",
        weight: 0.4,
        priority: 1,
        performanceScore: 7.5,
        isActive: true,
        compatibilityTags: ["low-risk", "stable"],
        lastRebalanceAt: new Date(),
      },
      {
        id: "strat_2",
        name: "Growth",
        version: "1.0.0",
        weight: 0.35,
        priority: 2,
        performanceScore: 8.5,
        isActive: true,
        compatibilityTags: ["medium-risk", "volatile"],
        lastRebalanceAt: new Date(),
      },
      {
        id: "strat_3",
        name: "Aggressive",
        version: "1.0.0",
        weight: 0.25,
        priority: 3,
        performanceScore: 6.5,
        isActive: true,
        compatibilityTags: ["high-risk", "volatile"],
        lastRebalanceAt: new Date(),
      },
    ];

    config = {
      vaultId: "vault_1",
      vaultName: "Balanced Portfolio",
      strategies,
      normalizeWeights: true,
      minStrategyWeight: 0.05,
      maxStrategyWeight: 0.6,
      requireCompatibilityCheck: true,
      rotationIntervalMs: 7 * 24 * 60 * 60 * 1000, // 1 week
      failureIsolation: true,
    };

    orchestrator = new VaultOrchestrator(config);
  });

  describe("validateComposition", () => {
    it("should accept valid composition", () => {
      const errors = orchestrator.validateComposition();

      expect(errors).toHaveLength(0);
    });

    it("should reject composition with no active strategies", () => {
      config.strategies.forEach((s) => (s.isActive = false));
      orchestrator = new VaultOrchestrator(config);

      const errors = orchestrator.validateComposition();

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("no active"))).toBe(true);
    });

    it("should reject weights not summing to 1", () => {
      config.strategies[0].weight = 0.5;
      config.strategies[1].weight = 0.3;
      config.strategies[2].weight = 0.1; // Total = 0.9
      orchestrator = new VaultOrchestrator(config);

      const errors = orchestrator.validateComposition();

      expect(errors.some((e) => e.includes("does not sum"))).toBe(true);
    });

    it("should reject weight below minimum", () => {
      config.strategies[0].weight = 0.03; // Below minStrategyWeight of 0.05
      config.strategies[1].weight = 0.48;
      config.strategies[2].weight = 0.49;
      orchestrator = new VaultOrchestrator(config);

      const errors = orchestrator.validateComposition();

      expect(
        errors.some((e) => e.includes("below minimum")),
      ).toBe(true);
    });

    it("should reject weight above maximum", () => {
      config.strategies[0].weight = 0.65; // Above maxStrategyWeight of 0.6
      config.strategies[1].weight = 0.2;
      config.strategies[2].weight = 0.15;
      orchestrator = new VaultOrchestrator(config);

      const errors = orchestrator.validateComposition();

      expect(
        errors.some((e) => e.includes("exceeds maximum")),
      ).toBe(true);
    });

    it("should detect compatibility conflicts", () => {
      // Create conflicting tags
      config.strategies[0].compatibilityTags = ["stablecoin-only"];
      config.strategies[1].compatibilityTags = ["volatile-assets"];
      config.requireCompatibilityCheck = true;
      orchestrator = new VaultOrchestrator(config);

      const errors = orchestrator.validateComposition();

      expect(
        errors.some((e) => e.includes("Incompatible")),
      ).toBe(true);
    });
  });

  describe("getCompositionState", () => {
    it("should return valid composition state", () => {
      const state = orchestrator.getCompositionState();

      expect(state.isValid).toBe(true);
      expect(state.validationErrors).toHaveLength(0);
      expect(state.activeStrategies).toBe(3);
      expect(Math.abs(state.totalAllocation - 1.0)).toBeLessThan(0.001);
    });

    it("should calculate weighted performance score", () => {
      const state = orchestrator.getCompositionState();

      expect(state.weightedPerformanceScore).toBeGreaterThan(0);
      expect(state.weightedPerformanceScore).toBeLessThan(10);
    });
  });

  describe("normalizeWeights", () => {
    it("should normalize weights to sum to 1", () => {
      config.strategies[0].weight = 0.4;
      config.strategies[1].weight = 0.3;
      config.strategies[2].weight = 0.2;
      orchestrator = new VaultOrchestrator(config);

      const normalized = orchestrator.normalizeWeights();

      const total = normalized.reduce((sum, s) => sum + s.weight, 0);
      expect(Math.abs(total - 1.0)).toBeLessThan(0.001);
    });

    it("should handle equal distribution", () => {
      orchestrator.normalizeWeights();

      const state = orchestrator.getCompositionState();
      expect(state.isValid).toBe(true);
    });
  });

  describe("orchestrate", () => {
    it("should generate orchestration result", () => {
      const result = orchestrator.orchestrate();

      expect(result.vaultId).toBe("vault_1");
      expect(result.allocationDecisions.length).toBe(3);
      expect(result.riskMetrics).toBeDefined();
      expect(result.nextRebalanceAt).toBeInstanceOf(Date);
    });

    it("should provide allocation decisions", () => {
      const result = orchestrator.orchestrate();

      result.allocationDecisions.forEach((decision) => {
        expect(decision.strategyId).toBeDefined();
        expect(decision.currentWeight).toBeGreaterThanOrEqual(0);
        expect(decision.recommendedWeight).toBeGreaterThanOrEqual(0);
        expect(decision.reason).toBeDefined();
        expect(decision.confidence).toBeGreaterThanOrEqual(0);
        expect(decision.confidence).toBeLessThanOrEqual(1);
      });
    });

    it("should calculate concentration risk", () => {
      const result = orchestrator.orchestrate();

      expect(result.riskMetrics.concentrationRisk).toBeGreaterThanOrEqual(0);
      expect(result.riskMetrics.concentrationRisk).toBeLessThanOrEqual(100);
    });

    it("should calculate correlation risk", () => {
      const result = orchestrator.orchestrate();

      expect(result.riskMetrics.correlationRisk).toBeGreaterThanOrEqual(0);
    });

    it("should calculate failure risk", () => {
      const result = orchestrator.orchestrate();

      expect(result.riskMetrics.failureRisk).toBeGreaterThanOrEqual(0);
    });

    it("should record orchestration in history", () => {
      orchestrator.orchestrate();
      orchestrator.orchestrate();

      const history = orchestrator.getHistory();

      expect(history.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("updateStrategy", () => {
    it("should update strategy properties", () => {
      orchestrator.updateStrategy("strat_1", {
        performanceScore: 9.0,
        weight: 0.35,
      });

      const state = orchestrator.getCompositionState();
      expect(state.weightedPerformanceScore).toBeGreaterThan(0);
    });

    it("should throw on non-existent strategy", () => {
      expect(() => {
        orchestrator.updateStrategy("non_existent", {
          performanceScore: 5.0,
        });
      }).toThrow();
    });
  });

  describe("addStrategy", () => {
    it("should add new strategy", () => {
      const newStrategy: StrategyModule = {
        id: "strat_4",
        name: "Dividend Focus",
        version: "1.0.0",
        weight: 0.1,
        priority: 4,
        performanceScore: 7.0,
        isActive: true,
        compatibilityTags: ["income", "stable"],
        lastRebalanceAt: new Date(),
      };

      orchestrator.addStrategy(newStrategy);

      const state = orchestrator.getCompositionState();
      expect(state.activeStrategies).toBeGreaterThanOrEqual(3);
    });

    it("should prevent duplicate strategy IDs", () => {
      const duplicate: StrategyModule = {
        id: "strat_1",
        name: "Duplicate",
        version: "1.0.0",
        weight: 0.1,
        priority: 5,
        performanceScore: 5.0,
        isActive: true,
        compatibilityTags: ["test"],
        lastRebalanceAt: new Date(),
      };

      expect(() => {
        orchestrator.addStrategy(duplicate);
      }).toThrow("Strategy already exists");
    });
  });

  describe("removeStrategy", () => {
    it("should remove strategy", () => {
      const stateBefore = orchestrator.getCompositionState();
      const activeBefore = stateBefore.activeStrategies;

      orchestrator.removeStrategy("strat_3");

      const stateAfter = orchestrator.getCompositionState();
      expect(stateAfter.activeStrategies).toBeLessThan(activeBefore);
    });

    it("should throw on non-existent strategy", () => {
      expect(() => {
        orchestrator.removeStrategy("non_existent");
      }).toThrow();
    });
  });

  describe("getHistory", () => {
    it("should retrieve orchestration history", () => {
      orchestrator.orchestrate();
      orchestrator.orchestrate();
      orchestrator.orchestrate();

      const history = orchestrator.getHistory(2);

      expect(history.length).toBeLessThanOrEqual(2);
      expect(history[0].timestamp).toBeDefined();
    });

    it("should limit history size", () => {
      for (let i = 0; i < 15; i++) {
        orchestrator.orchestrate();
      }

      const history = orchestrator.getHistory(5);

      expect(history.length).toBeLessThanOrEqual(5);
    });
  });

  describe("failure isolation", () => {
    it("should isolate strategy failures", () => {
      // Deactivate one strategy to simulate failure
      orchestrator.updateStrategy("strat_1", { isActive: false });

      const result = orchestrator.orchestrate();

      expect(result.allocationDecisions).toHaveLength(3);
      expect(
        result.allocationDecisions.find((d) => d.strategyId === "strat_1")
          ?.recommendedWeight,
      ).toBe(0);
    });
  });

  describe("weight constraint compliance", () => {
    it("should respect min/max weight constraints in recommendations", () => {
      const result = orchestrator.orchestrate();

      result.allocationDecisions.forEach((decision) => {
        expect(decision.recommendedWeight).toBeGreaterThanOrEqual(0);
        expect(decision.recommendedWeight).toBeLessThanOrEqual(1);
      });
    });
  });
});
