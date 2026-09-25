import {
  AdaptiveCooldownOptimizer,
  computeCooldownVisualizationState,
} from "../adaptiveCooldownService";

describe("adaptive cooldown visualization state", () => {
  it("shows remaining cooldown timing and progress", () => {
    const state = computeCooldownVisualizationState(
      {
        lastRebalanceAt: new Date("2026-08-31T00:00:00.000Z"),
        cooldownMs: 60 * 60 * 1000,
        reasonCodes: ["NORMAL_CONDITIONS"],
      },
      new Date("2026-08-31T00:30:00.000Z"),
    );

    expect(state.status).toBe("cooling_down");
    expect(state.remainingMs).toBe(30 * 60 * 1000);
    expect(state.progressPct).toBe(50);
    expect(state.displayLabel).toBe("Available in 0h");
  });

  it("marks degraded cooldowns as extended for dashboard badges", () => {
    const optimizer = new AdaptiveCooldownOptimizer();
    const recommendation = optimizer.recommendCooldown({
      strategyId: "strategy-1",
      volatility: 90,
      liquidityScore: 10,
      consecutiveFailures: 4,
      lastRebalanceAt: new Date(),
    });

    expect(recommendation.cooldownState.status).toBe("extended");
    expect(recommendation.cooldownState.reasonCodes).toContain("HIGH_VOLATILITY");
  });
});