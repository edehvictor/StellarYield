import {
  RiskRuleEngineError,
  evaluateAllocationChange,
  type RiskRuleVerdict,
} from "../services/riskRuleEngine";

describe("evaluateAllocationChange", () => {
  it("allows a normal allocation change within all thresholds", () => {
    const result = evaluateAllocationChange({
      changes: [{ vaultId: "vault-blend", beforePct: 20, afterPct: 25 }],
    });
    expect(result.allowed).toBe(true);
    expect(result.verdicts).toHaveLength(1);
    const [verdict] = result.verdicts;
    expect(verdict.passed).toBe(true);
    expect(verdict.severity).toBe("info");
  });

  it("blocks a change that exceeds the concentration cap", () => {
    const result = evaluateAllocationChange({
      changes: [{ vaultId: "v1", beforePct: 30, afterPct: 75 }],
    });
    expect(result.allowed).toBe(false);
    const verdict = result.verdicts.find((v) => v.rule === "max_allocation");
    expect(verdict?.code).toBe("MAX_ALLOCATION_EXCEEDED");
    expect(verdict?.severity).toBe("block");
  });

  it("blocks a single-step change above the step threshold", () => {
    const result = evaluateAllocationChange({
      changes: [{ vaultId: "v1", beforePct: 10, afterPct: 50 }],
    });
    expect(result.allowed).toBe(false);
    const verdict = result.verdicts.find((v) => v.rule === "step_change");
    expect(verdict?.code).toBe("STEP_CHANGE_EXCEEDS_THRESHOLD");
  });

  it("blocks dust allocations below the minimum non-zero percentage", () => {
    const result = evaluateAllocationChange({
      changes: [{ vaultId: "v1", beforePct: 0, afterPct: 0.005 }],
    });
    expect(result.allowed).toBe(false);
    const verdict = result.verdicts.find((v) => v.rule === "dust");
    expect(verdict?.code).toBe("DUST_ALLOCATION");
  });

  it("flags new strategies without an existing baseline as warnings", () => {
    const result = evaluateAllocationChange({
      changes: [{ vaultId: "v1", beforePct: 0, afterPct: 5 }],
    });
    const verdict = result.verdicts.find((v) => v.rule === "new_strategy");
    expect(verdict?.code).toBe("NEW_STRATEGY_WITHOUT_BASELINE");
    expect(verdict?.severity).toBe("warning");
    expect(result.allowed).toBe(true);
  });

  it("throws a typed error for an empty changes list", () => {
    expect(() => evaluateAllocationChange({ changes: [] })).toThrow(
      RiskRuleEngineError,
    );
    try {
      evaluateAllocationChange({ changes: [] });
    } catch (error) {
      expect((error as RiskRuleEngineError).code).toBe("EMPTY_CHANGES");
    }
  });

  it("throws a typed error for negative percentages", () => {
    expect(() =>
      evaluateAllocationChange({ changes: [{ vaultId: "v1", beforePct: -1, afterPct: 5 }] }),
    ).toThrow(RiskRuleEngineError);
    try {
      evaluateAllocationChange({ changes: [{ vaultId: "v1", beforePct: 10, afterPct: -5 }] });
    } catch (error) {
      expect((error as RiskRuleEngineError).code).toBe("INVALID_PCT");
    }
  });

  it("downgrades concentration violations via warnOnly", () => {
    const result = evaluateAllocationChange({
      changes: [{ vaultId: "v1", beforePct: 50, afterPct: 75 }],
      rules: { warnOnly: true },
    });
    expect(result.allowed).toBe(true);
    const verdict = result.verdicts.find(
      (v) => v.rule === "max_allocation",
    ) as RiskRuleVerdict;
    expect(verdict.severity).toBe("warning");
    expect(verdict.passed).toBe(true);
  });
});