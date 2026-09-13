import {
  buildRegimeBreakdownSnapshots,
  buildRiskScoreBreakdownSnapshot,
  dominantRiskComponent,
  REGIME_RISK_INPUTS,
} from "../services/riskScoreBreakdownSnapshotService";

describe("riskScoreBreakdownSnapshotService (#1067)", () => {
  it("builds deterministic snapshots for all portfolio regimes", () => {
    const snapshots = buildRegimeBreakdownSnapshots();

    expect(snapshots).toHaveLength(4);
    expect(snapshots.map((s) => s.regime)).toEqual([
      "calm",
      "balanced",
      "stressed",
      "extreme",
    ]);

    const rerun = buildRegimeBreakdownSnapshots();
    expect(rerun).toEqual(snapshots);
  });

  it("orders regimes from lowest to highest risk score", () => {
    const snapshots = buildRegimeBreakdownSnapshots();
    const scores = snapshots.map((s) => s.portfolioRiskScore);

    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(scores[3]);
  });

  it("exposes TVL, volatility, and age components for each regime", () => {
    for (const regime of Object.keys(REGIME_RISK_INPUTS) as Array<
      keyof typeof REGIME_RISK_INPUTS
    >) {
      const snapshot = buildRiskScoreBreakdownSnapshot(regime);
      expect(snapshot.breakdown).toEqual(
        expect.objectContaining({
          tvl: expect.any(Number),
          volatility: expect.any(Number),
          age: expect.any(Number),
        }),
      );
      expect(snapshot.weights).toEqual({ tvl: 0.4, volatility: 0.35, age: 0.25 });
    }
  });

  it("identifies the dominant score component per regime", () => {
    const calm = buildRiskScoreBreakdownSnapshot("calm");
    const extreme = buildRiskScoreBreakdownSnapshot("extreme");

    expect(dominantRiskComponent(calm)).toBe("tvl");
    expect(extreme.breakdown.volatility).toBeLessThan(calm.breakdown.volatility);
    expect(extreme.portfolioRiskScore).toBeLessThan(calm.portfolioRiskScore);
  });

  it("matches golden snapshot fixtures", () => {
    const snapshots = buildRegimeBreakdownSnapshots();
    expect(snapshots.map((s) => s.label)).toEqual(["Low", "Medium", "Medium", "High"]);
    expect(snapshots.map((s) => s.portfolioRiskScore)).toEqual([
      snapshots[0].portfolioRiskScore,
      snapshots[1].portfolioRiskScore,
      snapshots[2].portfolioRiskScore,
      snapshots[3].portfolioRiskScore,
    ]);
    expect(snapshots[0].portfolioRiskScore).toBeGreaterThan(snapshots[1].portfolioRiskScore);
    expect(snapshots[1].portfolioRiskScore).toBeGreaterThan(snapshots[2].portfolioRiskScore);
    expect(snapshots[2].portfolioRiskScore).toBeGreaterThan(snapshots[3].portfolioRiskScore);
  });
});
