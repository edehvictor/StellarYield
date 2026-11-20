/**
 * Deterministic rounding tests for blendApyPercent (issue #1399).
 *
 * These tests exercise the round-once-at-emit guarantee: intermediate floating
 * point arithmetic must not accumulate rounding drift, and the final result
 * must always be rounded to exactly 2 decimal places using half-away-from-zero
 * semantics.
 */
import { describe, it, expect } from "vitest";
import { blendApyPercent } from "../utils/yieldNormalizationContract";

// ── Basic weighted-average contract ──────────────────────────────────────────

describe("blendApyPercent — weighted average", () => {
  it("returns exact rounded result for a simple two-way blend", () => {
    // (6.75 * 0.75) + (11.2 * 0.25) = 7.8625 → rounds to 7.86
    expect(blendApyPercent([
      { apyPercent: 6.75,  weight: 7_500 },
      { apyPercent: 11.2,  weight: 2_500 },
    ])).toBe(7.86);
  });

  it("returns exact rounded result for a three-way blend", () => {
    // (5.0 * 1/3) + (10.0 * 1/3) + (7.5 * 1/3) = 7.5 → 7.5
    expect(blendApyPercent([
      { apyPercent: 5.0,  weight: 1 },
      { apyPercent: 10.0, weight: 1 },
      { apyPercent: 7.5,  weight: 1 },
    ])).toBe(7.5);
  });

  it("weights act as ratios — scaling all by the same factor gives the same result", () => {
    const small = blendApyPercent([
      { apyPercent: 6.0, weight: 1 },
      { apyPercent: 9.0, weight: 3 },
    ]);
    const large = blendApyPercent([
      { apyPercent: 6.0, weight: 1_000_000 },
      { apyPercent: 9.0, weight: 3_000_000 },
    ]);
    expect(small).toBe(large);
    // (6*0.25 + 9*0.75) = 1.5 + 6.75 = 8.25
    expect(small).toBe(8.25);
  });

  it("single-entry blend equals the sole apy rounded to 2dp", () => {
    expect(blendApyPercent([{ apyPercent: 12.345, weight: 999 }])).toBe(12.35);
  });
});

// ── Round-once-at-emit — tie-breaking determinism ────────────────────────────

describe("blendApyPercent — half-away-from-zero rounding", () => {
  it("rounds 0.005 up to 0.01 (half-away)", () => {
    // 0.005 exactly → should round UP to 0.01 (half-away-from-zero)
    expect(blendApyPercent([{ apyPercent: 0.005, weight: 1 }])).toBe(0.01);
  });

  it("rounds 0.004 down to 0.00", () => {
    expect(blendApyPercent([{ apyPercent: 0.004, weight: 1 }])).toBe(0);
  });

  it("rounds -0.005 away from zero to -0.01", () => {
    expect(blendApyPercent([{ apyPercent: -0.005, weight: 1 }])).toBe(-0.01);
  });

  it("known IEEE 754 trap: 1.005 rounds correctly to 1.01", () => {
    // In raw floating point, 1.005 * 100 === 100.49999... which rounds DOWN.
    // The toPrecision(15) guard in roundTo prevents this.
    expect(blendApyPercent([{ apyPercent: 1.005, weight: 1 }])).toBe(1.01);
  });

  it("known IEEE 754 trap: 2.675 rounds correctly to 2.68", () => {
    // 2.675 * 100 === 267.49999... in binary — same trap as 1.005.
    expect(blendApyPercent([{ apyPercent: 2.675, weight: 1 }])).toBe(2.68);
  });
});

// ── Zero / empty weight edge cases ────────────────────────────────────────────

describe("blendApyPercent — zero and empty inputs", () => {
  it("returns 0 for an empty array", () => {
    expect(blendApyPercent([])).toBe(0);
  });

  it("returns 0 when all weights are 0", () => {
    expect(blendApyPercent([
      { apyPercent: 10, weight: 0 },
      { apyPercent: 20, weight: 0 },
    ])).toBe(0);
  });

  it("skips zero-weight entries — only positive weights contribute", () => {
    // Only the 8.0% position matters
    expect(blendApyPercent([
      { apyPercent: 8.0,  weight: 1_000 },
      { apyPercent: 99.0, weight: 0 },
    ])).toBe(8.0);
  });

  it("ignores negative weights (treated as zero)", () => {
    expect(blendApyPercent([
      { apyPercent: 5.0, weight: -500 },
      { apyPercent: 8.0, weight: 1_000 },
    ])).toBe(8.0);
  });

  it("returns 0 (not NaN) when only negative-weight entries exist", () => {
    const result = blendApyPercent([{ apyPercent: 5.0, weight: -1 }]);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });
});

// ── Result is always 2-decimal precision ──────────────────────────────────────

describe("blendApyPercent — output precision contract", () => {
  const cases: Array<[ReadonlyArray<{ apyPercent: number; weight: number }>, number]> = [
    [[{ apyPercent: 1.0,   weight: 1 }], 1.0],
    [[{ apyPercent: 1.1,   weight: 1 }], 1.1],
    [[{ apyPercent: 1.11,  weight: 1 }], 1.11],
    [[{ apyPercent: 1.111, weight: 1 }], 1.11],
    [[{ apyPercent: 1.115, weight: 1 }], 1.12], // rounds up
    [[{ apyPercent: 1.114, weight: 1 }], 1.11], // rounds down
    [[{ apyPercent: 0.0,   weight: 1 }], 0],
  ];

  for (const [parts, expected] of cases) {
    it(`blendApyPercent([apyPercent=${parts[0].apyPercent}]) === ${expected}`, () => {
      expect(blendApyPercent(parts)).toBe(expected);
    });
  }

  it("result never has more than 2 decimal places", () => {
    // Use a blend that produces a long recurring decimal before rounding
    // 1/3 + 1/3 + 1/3 of (1.01, 2.02, 3.03) = 2.02 exactly
    const r = blendApyPercent([
      { apyPercent: 1.01, weight: 1 },
      { apyPercent: 2.02, weight: 1 },
      { apyPercent: 3.03, weight: 1 },
    ]);
    const str = r.toString();
    const dp = str.includes(".") ? str.split(".")[1].length : 0;
    expect(dp).toBeLessThanOrEqual(2);
  });
});

// ── Symmetry and commutativity ────────────────────────────────────────────────

describe("blendApyPercent — order independence", () => {
  it("same weights in different order give the same result", () => {
    const a = blendApyPercent([
      { apyPercent: 5.0,  weight: 3_000 },
      { apyPercent: 10.0, weight: 1_000 },
      { apyPercent: 7.5,  weight: 6_000 },
    ]);
    const b = blendApyPercent([
      { apyPercent: 7.5,  weight: 6_000 },
      { apyPercent: 10.0, weight: 1_000 },
      { apyPercent: 5.0,  weight: 3_000 },
    ]);
    expect(a).toBe(b);
  });
});
