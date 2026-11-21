import request from "supertest";
import express from "express";
import governanceRouter from "../routes/governance";
import {
  forecastGovernanceProposal,
  roundToDecimals,
  clampNumber,
  type GovernanceForecastInput,
} from "../services/governanceForecastService";
import { computeSignerQuorumProgress } from "../services/signerQuorumService";

const app = express();
app.use(express.json());
app.use("/api/governance", governanceRouter);

describe("Governance Boundary-Value Calculations — Server", () => {
  const baseBaseline = {
    yieldPct: 8,
    exposurePct: 40,
    feeRatePct: 2,
    tvlUsd: 10_000_000,
    riskScore: 50,
    vaultCount: 3,
  };

  function makeInput(
    overrides: Partial<GovernanceForecastInput> = {},
  ): GovernanceForecastInput {
    return {
      proposalType: "fee_change",
      parameters: { feeRatePct: 3 },
      baseline: baseBaseline,
      ...overrides,
    };
  }

  describe("Documented Rounding and Checked Math Helpers", () => {
    it("rounds half-up to exact decimal places and sanitizes -0", () => {
      expect(roundToDecimals(1.23456, 4)).toBe(1.2346);
      expect(roundToDecimals(1.23454, 4)).toBe(1.2345);
      expect(roundToDecimals(-0.00001, 4)).toBe(0);
      expect(Object.is(roundToDecimals(-0.000001, 4), 0)).toBe(true);
      expect(roundToDecimals(10.555, 2)).toBe(10.56);
      expect(roundToDecimals(NaN, 2)).toBe(0);
      expect(roundToDecimals(Infinity, 4)).toBe(0);
    });

    it("clamps numbers safely within bounds and handles non-finite", () => {
      expect(clampNumber(5, 0, 10)).toBe(5);
      expect(clampNumber(-5, 0, 10)).toBe(0);
      expect(clampNumber(15, 0, 10)).toBe(10);
      expect(clampNumber(NaN, 0, 10)).toBe(0);
      expect(clampNumber(Infinity, 0, 10)).toBe(10);
      expect(clampNumber(-Infinity, 0, 10)).toBe(0);
    });
  });

  describe("Forecast Boundary Calculations", () => {
    it("handles zero fee boundary (0%)", () => {
      const result = forecastGovernanceProposal(
        makeInput({ parameters: { feeRatePct: 0 } }),
      );
      expect(result.forecast.projectedFeeRatePct).toBe(0);
      expect(result.forecast.feeRevenueDeltaUsd).toBeLessThan(0);
      expect(result.impactSummary.irreversible).toBe(true);
    });

    it("handles maximum fee boundary (100%)", () => {
      const result = forecastGovernanceProposal(
        makeInput({ parameters: { feeRatePct: 100 } }),
      );
      expect(result.forecast.projectedFeeRatePct).toBe(100);
      expect(result.forecast.yieldDeltaPct).toBeLessThan(0);
      expect(result.impactSummary.irreversible).toBe(true);
    });

    it("handles zero TVL boundary ($0) without division-by-zero or NaN", () => {
      const result = forecastGovernanceProposal(
        makeInput({
          baseline: { ...baseBaseline, tvlUsd: 0 },
          parameters: { feeRatePct: 5 },
        }),
      );
      expect(result.forecast.feeRevenueDeltaUsd).toBe(0);
      expect(Number.isFinite(result.forecast.feeRevenueDeltaUsd)).toBe(true);
    });

    it("handles near-limit high TVL ($1 Trillion) safely", () => {
      const result = forecastGovernanceProposal(
        makeInput({
          baseline: { ...baseBaseline, tvlUsd: 1_000_000_000_000 },
          parameters: { feeRatePct: 3 },
        }),
      );
      expect(result.forecast.feeRevenueDeltaUsd).toBe(800_000_000);
      expect(Number.isFinite(result.forecast.feeRevenueDeltaUsd)).toBe(true);
    });

    it("handles zero baseline yield (0%) safely", () => {
      const result = forecastGovernanceProposal(
        makeInput({
          baseline: { ...baseBaseline, yieldPct: 0 },
          parameters: { feeRatePct: 5 },
        }),
      );
      expect(result.forecast.yieldDeltaPct).toBe(0);
      expect(result.forecast.feeRevenueDeltaUsd).toBe(0);
      expect(result.forecast.projectedYieldPct).toBe(0);
    });

    it("handles zero allocation limit (0% concentration)", () => {
      const result = forecastGovernanceProposal(
        makeInput({
          proposalType: "allocation_limit",
          parameters: { maxConcentrationPct: 0 },
        }),
      );
      expect(result.forecast.projectedExposurePct).toBe(0);
      expect(result.impactSummary.irreversible).toBe(true);
    });

    it("handles maximum allocation limit (100% concentration)", () => {
      const result = forecastGovernanceProposal(
        makeInput({
          proposalType: "allocation_limit",
          parameters: { maxConcentrationPct: 100 },
        }),
      );
      expect(result.forecast.projectedExposurePct).toBe(100);
      expect(result.forecast.exposureDeltaPct).toBe(60);
    });

    it("handles strategy multiplier boundaries (zero, negative, large)", () => {
      const zeroMul = forecastGovernanceProposal(
        makeInput({
          proposalType: "strategy_param",
          parameters: { apyMultiplier: 0, riskMultiplier: -1 },
        }),
      );
      expect(zeroMul.warnings.length).toBeGreaterThan(0);
      expect(Number.isFinite(zeroMul.forecast.projectedYieldPct)).toBe(true);
      expect(Number.isFinite(zeroMul.forecast.projectedExposurePct)).toBe(true);

      const largeMul = forecastGovernanceProposal(
        makeInput({
          proposalType: "strategy_param",
          parameters: { apyMultiplier: 5000, riskMultiplier: 5000 },
        }),
      );
      expect(largeMul.forecast.projectedExposurePct).toBe(100);
      expect(Number.isFinite(largeMul.forecast.projectedYieldPct)).toBe(true);
    });
  });

  describe("Signer Quorum Progress Boundary Calculations", () => {
    const signers = Array.from({ length: 1000 }, (_, i) => `G${String(i).padStart(55, "A")}`);

    it("does not round up to 100% at near-limit progress (999 of 1000)", () => {
      const signatures = signers.slice(0, 999);
      const progress = computeSignerQuorumProgress({
        signers,
        signatures,
        threshold: 1000,
      });

      expect(progress.signed).toBe(999);
      expect(progress.remaining).toBe(1);
      expect(progress.met).toBe(false);
      // Floor/cap rounding ensures 999/1000 is 99%, never premature 100%
      expect(progress.progressPct).toBe(99);
    });

    it("attains exactly 100% when threshold is reached", () => {
      const signatures = signers.slice(0, 1000);
      const progress = computeSignerQuorumProgress({
        signers,
        signatures,
        threshold: 1000,
      });

      expect(progress.signed).toBe(1000);
      expect(progress.remaining).toBe(0);
      expect(progress.met).toBe(true);
      expect(progress.progressPct).toBe(100);
    });

    it("handles zero and negative threshold safely", () => {
      const progressZero = computeSignerQuorumProgress({
        signers: ["GA", "GB"],
        signatures: [],
        threshold: 0,
      });
      expect(progressZero.required).toBe(1);
      expect(progressZero.progressPct).toBe(0);
      expect(progressZero.met).toBe(false);

      const progressNeg = computeSignerQuorumProgress({
        signers: ["GA", "GB"],
        signatures: ["GA"],
        threshold: -5,
      });
      expect(progressNeg.required).toBe(1);
      expect(progressNeg.progressPct).toBe(100);
      expect(progressNeg.met).toBe(true);
    });

    it("handles empty signers list", () => {
      const progress = computeSignerQuorumProgress({
        signers: [],
        signatures: ["GA"],
        threshold: 2,
      });
      expect(progress.signed).toBe(0);
      expect(progress.required).toBe(2);
      expect(progress.met).toBe(false);
      expect(progress.progressPct).toBe(0);
    });
  });

  describe("API Boundary Validation & State Preservation", () => {
    it("rejects negative TVL with 400 VALIDATION_FAILED", async () => {
      const res = await request(app)
        .post("/api/governance/forecast")
        .send({
          proposalType: "fee_change",
          parameters: { feeRatePct: 3 },
          baseline: { ...baseBaseline, tvlUsd: -100 },
        })
        .expect(400);

      expect(res.body.error).toBe("VALIDATION_FAILED");
      expect(res.body.stage).toBe("request-validation");
      expect(res.body.fields).toContain("baseline");
      expect(res.body.diagnostics[0].summary).toBeTruthy();
    });

    it("rejects out-of-range baseline feeRatePct (> 100)", async () => {
      const res = await request(app)
        .post("/api/governance/forecast")
        .send({
          proposalType: "fee_change",
          parameters: { feeRatePct: 3 },
          baseline: { ...baseBaseline, feeRatePct: 105 },
        })
        .expect(400);

      expect(res.body.error).toBe("VALIDATION_FAILED");
      expect(res.body.fields).toContain("baseline");
    });

    it("rejects non-finite parameter values", async () => {
      const res = await request(app)
        .post("/api/governance/forecast")
        .send({
          proposalType: "fee_change",
          parameters: { feeRatePct: "NaN" },
          baseline: baseBaseline,
        })
        .expect(400);

      expect(res.body.error).toBe("VALIDATION_FAILED");
      expect(res.body.fields).toContain("parameters");
    });

    it("rejects negative quorum threshold", async () => {
      const res = await request(app)
        .post("/api/governance/quorum-progress")
        .send({
          signers: ["GA", "GB"],
          signatures: [],
          threshold: -1,
        })
        .expect(400);

      expect(res.body.error).toBe("INVALID_REQUEST");
      expect(res.body.fields).toContain("threshold");
    });

    it("preserves safe deterministic retry behavior", async () => {
      // First call succeeds
      const res1 = await request(app)
        .post("/api/governance/forecast")
        .send({
          proposalType: "fee_change",
          parameters: { feeRatePct: 4 },
          baseline: baseBaseline,
        })
        .expect(200);

      // Second identical call produces identical results
      const res2 = await request(app)
        .post("/api/governance/forecast")
        .send({
          proposalType: "fee_change",
          parameters: { feeRatePct: 4 },
          baseline: baseBaseline,
        })
        .expect(200);

      expect(res1.body).toEqual(res2.body);
    });
  });
});
