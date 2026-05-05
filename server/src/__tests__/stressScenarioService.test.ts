import { runStressScenario } from "../services/stressScenarioService";

describe("stressScenarioService", () => {
  it("simulates apy collapse with expected loss output", () => {
    const result = runStressScenario({
      scenario: "apy-collapse",
      initialValueUsd: 10_000,
      baseApyPct: 10,
      days: 90,
    });

    expect(result.expectedLossUsd).toBeGreaterThan(0);
    expect(result.expectedLossPct).toBeGreaterThan(0);
    expect(result.recoveryDaysEstimate).toBeGreaterThanOrEqual(0);
  });

  it("keeps scenario output bounded for edge arithmetic", () => {
    const result = runStressScenario({
      scenario: "oracle-shock",
      initialValueUsd: -999,
      baseApyPct: 9999,
      days: 9999,
    });

    expect(result.projectedFinalValueUsd).toBeGreaterThan(0);
    expect(result.expectedLossPct).toBeLessThanOrEqual(100);
  });
});
