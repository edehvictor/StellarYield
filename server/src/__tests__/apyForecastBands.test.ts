/**
 * APY Forecast Confidence Interval Tests (#419)
 *
 * Tests for forecast band calculation (lower/median/upper),
 * confidence inputs (volatility, data completeness, model fit),
 * and chart label rendering.
 */

import { predictApy, ema, linearRegression } from "../../analytics/apyPredictor";

function makeHistory(baseApy: number, days = 14) {
  const now = new Date();
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(now);
    date.setDate(now.getDate() - (days - i));
    return {
      date: date.toISOString().split("T")[0],
      apy: baseApy + Math.sin(i / 2) * 0.3,
      tvl: 1_000_000,
    };
  });
}

// ── Forecast band calculation ─────────────────────────────────────────────────

describe("predictApy forecast bands", () => {
  it("returns lower, median (predictedApy), and upper bands for each prediction point", () => {
    const result = predictApy("Blend", makeHistory(6.5), 7);
    expect(result.predictions).toHaveLength(7);

    for (const point of result.predictions) {
      expect(typeof point.lowerApy).toBe("number");
      expect(typeof point.predictedApy).toBe("number");
      expect(typeof point.upperApy).toBe("number");
      expect(point.lowerApy).toBeLessThanOrEqual(point.predictedApy);
      expect(point.upperApy).toBeGreaterThanOrEqual(point.predictedApy);
    }
  });

  it("lower band is always >= 0", () => {
    const result = predictApy("Blend", makeHistory(0.5), 7);
    for (const point of result.predictions) {
      expect(point.lowerApy).toBeGreaterThanOrEqual(0);
    }
  });

  it("upper band is always finite", () => {
    const result = predictApy("Soroswap", makeHistory(12.0), 7);
    for (const point of result.predictions) {
      expect(Number.isFinite(point.upperApy)).toBe(true);
    }
  });

  it("confidence decreases further into the future", () => {
    const result = predictApy("DeFindex", makeHistory(8.0), 7);
    const confidences = result.predictions.map((p) => p.confidence);
    // Each day should have confidence <= the previous day
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i]).toBeLessThanOrEqual(confidences[i - 1] + 0.01); // allow tiny float rounding
    }
  });

  it("confidence is between 0.1 and 1.0 for all points", () => {
    const result = predictApy("Blend", makeHistory(6.5), 7);
    for (const point of result.predictions) {
      expect(point.confidence).toBeGreaterThanOrEqual(0.1);
      expect(point.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it("band width increases further into the future (uncertainty grows)", () => {
    const result = predictApy("Blend", makeHistory(6.5), 7);
    const bandWidths = result.predictions.map((p) => p.upperApy - p.lowerApy);
    // Last day band should be wider than first day band
    expect(bandWidths[bandWidths.length - 1]).toBeGreaterThanOrEqual(bandWidths[0]);
  });
});

// ── Confidence inputs ─────────────────────────────────────────────────────────

describe("predictApy confidence inputs", () => {
  it("returns volatilityPct, dataCompleteness, and modelFit", () => {
    const result = predictApy("Blend", makeHistory(6.5), 7);
    const { confidenceInputs } = result;

    expect(typeof confidenceInputs.volatilityPct).toBe("number");
    expect(typeof confidenceInputs.dataCompleteness).toBe("number");
    expect(typeof confidenceInputs.modelFit).toBe("number");
  });

  it("volatilityPct is >= 0", () => {
    const result = predictApy("Blend", makeHistory(6.5), 7);
    expect(result.confidenceInputs.volatilityPct).toBeGreaterThanOrEqual(0);
  });

  it("dataCompleteness is between 0 and 1", () => {
    const result = predictApy("Blend", makeHistory(6.5), 7);
    expect(result.confidenceInputs.dataCompleteness).toBeGreaterThan(0);
    expect(result.confidenceInputs.dataCompleteness).toBeLessThanOrEqual(1);
  });

  it("modelFit is between 0 and 1", () => {
    const result = predictApy("Blend", makeHistory(6.5), 7);
    expect(result.confidenceInputs.modelFit).toBeGreaterThanOrEqual(0);
    expect(result.confidenceInputs.modelFit).toBeLessThanOrEqual(1);
  });

  it("short history produces lower dataCompleteness than full history", () => {
    const shortResult = predictApy("Blend", makeHistory(6.5, 5), 7);
    const fullResult = predictApy("Blend", makeHistory(6.5, 30), 7);
    expect(shortResult.confidenceInputs.dataCompleteness).toBeLessThan(
      fullResult.confidenceInputs.dataCompleteness,
    );
  });

  it("high-volatility data produces higher volatilityPct", () => {
    const stableHistory = makeHistory(6.5, 14).map((p) => ({ ...p, apy: 6.5 }));
    const volatileHistory = makeHistory(6.5, 14).map((p, i) => ({
      ...p,
      apy: 6.5 + (i % 2 === 0 ? 3 : -3),
    }));

    const stableResult = predictApy("Blend", stableHistory, 7);
    const volatileResult = predictApy("Blend", volatileHistory, 7);

    expect(volatileResult.confidenceInputs.volatilityPct).toBeGreaterThan(
      stableResult.confidenceInputs.volatilityPct,
    );
  });
});

// ── Trend detection ───────────────────────────────────────────────────────────

describe("predictApy trend detection", () => {
  it("detects rising trend", () => {
    const risingHistory = Array.from({ length: 14 }, (_, i) => ({
      date: new Date(Date.now() - (14 - i) * 86400000).toISOString().split("T")[0],
      apy: 5 + i * 0.5,
    }));
    const result = predictApy("Blend", risingHistory, 7);
    expect(result.trend).toBe("rising");
  });

  it("detects falling trend", () => {
    const fallingHistory = Array.from({ length: 14 }, (_, i) => ({
      date: new Date(Date.now() - (14 - i) * 86400000).toISOString().split("T")[0],
      apy: 12 - i * 0.5,
    }));
    const result = predictApy("Blend", fallingHistory, 7);
    expect(result.trend).toBe("falling");
  });

  it("detects stable trend for flat data", () => {
    const flatHistory = Array.from({ length: 14 }, (_, i) => ({
      date: new Date(Date.now() - (14 - i) * 86400000).toISOString().split("T")[0],
      apy: 7.0,
    }));
    const result = predictApy("Blend", flatHistory, 7);
    expect(result.trend).toBe("stable");
  });
});

// ── Fallback for insufficient data ────────────────────────────────────────────

describe("predictApy with insufficient data", () => {
  it("returns flat predictions for fewer than 3 data points", () => {
    const shortHistory = [
      { date: "2026-05-01", apy: 6.0 },
      { date: "2026-05-02", apy: 6.1 },
    ];
    const result = predictApy("Blend", shortHistory, 7);
    expect(result.predictions).toHaveLength(7);
    expect(result.trend).toBe("stable");
    for (const point of result.predictions) {
      expect(point.lowerApy).toBeLessThanOrEqual(point.predictedApy);
      expect(point.upperApy).toBeGreaterThanOrEqual(point.predictedApy);
    }
  });
});

// ── EMA and linear regression primitives ─────────────────────────────────────

describe("ema", () => {
  it("returns same length as input", () => {
    const data = [1, 2, 3, 4, 5];
    expect(ema(data, 3)).toHaveLength(5);
  });

  it("returns empty array for empty input", () => {
    expect(ema([], 3)).toHaveLength(0);
  });

  it("smooths noisy data (output variance < input variance)", () => {
    const noisy = [10, 1, 10, 1, 10, 1, 10, 1];
    const smoothed = ema(noisy, 3);
    const inputVariance = noisy.reduce((s, v) => s + (v - 5.5) ** 2, 0);
    const mean = smoothed.reduce((s, v) => s + v, 0) / smoothed.length;
    const outputVariance = smoothed.reduce((s, v) => s + (v - mean) ** 2, 0);
    expect(outputVariance).toBeLessThan(inputVariance);
  });
});

describe("linearRegression", () => {
  it("returns slope=0 and intercept=mean for constant data", () => {
    const { slope, intercept } = linearRegression([5, 5, 5, 5, 5]);
    expect(slope).toBeCloseTo(0, 5);
    expect(intercept).toBeCloseTo(5, 5);
  });

  it("returns positive slope for increasing data", () => {
    const { slope } = linearRegression([1, 2, 3, 4, 5]);
    expect(slope).toBeGreaterThan(0);
  });

  it("returns r2 close to 1 for perfectly linear data", () => {
    const { r2 } = linearRegression([1, 2, 3, 4, 5]);
    expect(r2).toBeCloseTo(1, 3);
  });

  it("handles single-element array", () => {
    const { slope, intercept } = linearRegression([7]);
    expect(slope).toBe(0);
    expect(intercept).toBe(7);
  });
});
