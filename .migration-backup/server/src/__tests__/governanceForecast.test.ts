import {
  forecastGovernanceProposal,
  type GovernanceForecastInput,
} from "../services/governanceForecastService";

const baseBaseline = {
  yieldPct: 8,
  exposurePct: 40,
  feeRatePct: 2,
  tvlUsd: 10_000_000,
  riskScore: 50,
  vaultCount: 3,
};

function makeInput(overrides: Partial<GovernanceForecastInput> = {}): GovernanceForecastInput {
  return {
    proposalType: "fee_change",
    parameters: { feeRatePct: 3 },
    baseline: baseBaseline,
    ...overrides,
  };
}

describe("forecastGovernanceProposal — fee_change", () => {
  it("projects a lower yield when fee increases", () => {
    const result = forecastGovernanceProposal(makeInput({ parameters: { feeRatePct: 5 } }));
    expect(result.forecast.yieldDeltaPct).toBeLessThan(0);
  });

  it("projects higher fee revenue when fee rate increases", () => {
    const result = forecastGovernanceProposal(makeInput({ parameters: { feeRatePct: 4 } }));
    expect(result.forecast.feeRevenueDeltaUsd).toBeGreaterThan(0);
  });

  it("no change when fee stays the same", () => {
    const result = forecastGovernanceProposal(
      makeInput({ parameters: { feeRatePct: baseBaseline.feeRatePct } }),
    );
    expect(result.forecast.yieldDeltaPct).toBe(0);
    expect(result.forecast.feeRevenueDeltaUsd).toBe(0);
  });

  it("clamps fee to 100 and warns", () => {
    const result = forecastGovernanceProposal(makeInput({ parameters: { feeRatePct: 150 } }));
    expect(result.forecast.projectedFeeRatePct).toBe(100);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("clamps fee to 0 and warns on negative", () => {
    const result = forecastGovernanceProposal(makeInput({ parameters: { feeRatePct: -5 } }));
    expect(result.forecast.projectedFeeRatePct).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("includes disclaimer in result", () => {
    const result = forecastGovernanceProposal(makeInput());
    expect(result.disclaimer).toBeTruthy();
  });
});

describe("Diversification & Allocation Limit", () => {
  it("reducing max concentration lowers exposure", () => {
    const result = forecastGovernanceProposal(
      makeInput({ proposalType: "allocation_limit", parameters: { maxConcentrationPct: 20 } }),
    );
    expect(result.forecast.exposureDeltaPct).toBeLessThan(0);
  });

  it("increasing max concentration raises exposure", () => {
    const result = forecastGovernanceProposal(
      makeInput({ proposalType: "allocation_limit", parameters: { maxConcentrationPct: 70 } }),
    );
    expect(result.forecast.exposureDeltaPct).toBeGreaterThan(0);
  });

  it("clamps out-of-range concentration and warns", () => {
    const result = forecastGovernanceProposal(
      makeInput({ proposalType: "allocation_limit", parameters: { maxConcentrationPct: 120 } }),
    );
    expect(result.forecast.projectedExposurePct).toBe(100);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("Strategy Parameters", () => {
  it("apyMultiplier > 1 increases projected yield", () => {
    const result = forecastGovernanceProposal(
      makeInput({ proposalType: "strategy_param", parameters: { apyMultiplier: 1.2, riskMultiplier: 1 } }),
    );
    expect(result.forecast.yieldDeltaPct).toBeGreaterThan(0);
  });

  it("apyMultiplier < 1 decreases projected yield", () => {
    const result = forecastGovernanceProposal(
      makeInput({ proposalType: "strategy_param", parameters: { apyMultiplier: 0.8, riskMultiplier: 1 } }),
    );
    expect(result.forecast.yieldDeltaPct).toBeLessThan(0);
  });

  it("warns when apyMultiplier <= 0", () => {
    const result = forecastGovernanceProposal(
      makeInput({ proposalType: "strategy_param", parameters: { apyMultiplier: 0, riskMultiplier: 1 } }),
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("Reward Changes", () => {
  it("flags incomplete reward changes as high risk", () => {
    const result = forecastGovernanceProposal(
      makeInput({
        proposalType: "reward_change",
        parameters: { rewardApyDelta: 1.2, isHighConfidence: 0 },
      }),
    );
    expect(result.impactSummary.riskLevel).toBe("high");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("Proposal Lifecycle Parity Simulation Tests", () => {
  it("successful proposal (valid bounds, improves parameters)", () => {
    const input = makeInput({
      proposalType: "strategy_param",
      parameters: { apyMultiplier: 1.1, riskMultiplier: 0.9 },
    });
    const result = forecastGovernanceProposal(input);

    expect(result.impactSummary.riskLevel).toBe("medium"); // 50 + 8 = 58 risk score -> medium
    expect(result.impactSummary.noOp).toBe(false);
    expect(result.impactSummary.irreversible).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.forecast.yieldDeltaPct).toBeGreaterThan(0);
    expect(result.forecast.exposureDeltaPct).toBeLessThan(0);
  });

  it("rejected/invalid proposal (violates contract parameters/bounds)", () => {
    const input = makeInput({
      proposalType: "fee_change",
      parameters: { feeRatePct: -15 }, // invalid fee rate
    });
    const result = forecastGovernanceProposal(input);

    expect(result.impactSummary.riskLevel).toBe("high");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings).toContain("feeRatePct must be between 0 and 100");
    expect(result.forecast.projectedFeeRatePct).toBe(0); // Clamped
  });

  it("expired/irreversible proposal (results in irreversible state change)", () => {
    const input = makeInput({
      proposalType: "fee_change",
      parameters: { feeRatePct: 100 }, // irreversible: max fee rate
    });
    const result = forecastGovernanceProposal(input);

    expect(result.impactSummary.irreversible).toBe(true);
    expect(result.impactSummary.riskLevel).toBe("low"); // No warning, risk score remains 50
  });
});
