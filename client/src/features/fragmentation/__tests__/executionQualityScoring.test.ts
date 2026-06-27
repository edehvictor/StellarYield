import { describe, it, expect } from "vitest";
import {
  classifyExecutionQuality,
  classifyFragmentationScore,
  formatQualityScore,
  QUALITY_THRESHOLDS,
  QUALITY_SCALE,
  FRAGMENTATION_THRESHOLDS,
} from "../executionQualityUtils";

// ── classifyExecutionQuality — interior values ───────────────────────────────

describe("classifyExecutionQuality — interior values", () => {
  it("classifies a clearly good score", () => {
    const result = classifyExecutionQuality(85);
    expect(result.label).toBe("Good");
    expect(result.tier).toBe("good");
    expect(result.materialImpact).toBe(false);
  });

  it("classifies a clearly fair score", () => {
    const result = classifyExecutionQuality(60);
    expect(result.label).toBe("Fair");
    expect(result.tier).toBe("fair");
    expect(result.materialImpact).toBe(true);
  });

  it("classifies a clearly poor score", () => {
    const result = classifyExecutionQuality(30);
    expect(result.label).toBe("Poor");
    expect(result.tier).toBe("poor");
    expect(result.materialImpact).toBe(true);
  });
});

// ── classifyExecutionQuality — Good/Fair boundary (70) ───────────────────────

describe("classifyExecutionQuality — Good/Fair boundary at 70", () => {
  it("70.0 is Good (on the threshold — inclusive lower bound)", () => {
    const result = classifyExecutionQuality(QUALITY_THRESHOLDS.GOOD);
    expect(result.label).toBe("Good");
    expect(result.materialImpact).toBe(false);
  });

  it("69.9 is Fair (just below Good threshold)", () => {
    const result = classifyExecutionQuality(69.9);
    expect(result.label).toBe("Fair");
    expect(result.materialImpact).toBe(true);
  });

  it("70.1 is Good (just above threshold)", () => {
    const result = classifyExecutionQuality(70.1);
    expect(result.label).toBe("Good");
    expect(result.materialImpact).toBe(false);
  });

  it("material impact flips exactly at 70", () => {
    expect(classifyExecutionQuality(70).materialImpact).toBe(false);
    expect(classifyExecutionQuality(69.999).materialImpact).toBe(true);
  });
});

// ── classifyExecutionQuality — Fair/Poor boundary (50) ──────────────────────

describe("classifyExecutionQuality — Fair/Poor boundary at 50", () => {
  it("50.0 is Fair (on the threshold — inclusive lower bound)", () => {
    const result = classifyExecutionQuality(QUALITY_THRESHOLDS.FAIR);
    expect(result.label).toBe("Fair");
    expect(result.tier).toBe("fair");
  });

  it("49.9 is Poor (just below Fair threshold)", () => {
    const result = classifyExecutionQuality(49.9);
    expect(result.label).toBe("Poor");
    expect(result.tier).toBe("poor");
  });

  it("50.1 is Fair (just above Fair threshold)", () => {
    const result = classifyExecutionQuality(50.1);
    expect(result.label).toBe("Fair");
  });

  it("both Fair and Poor carry materialImpact=true", () => {
    expect(classifyExecutionQuality(50).materialImpact).toBe(true);
    expect(classifyExecutionQuality(49).materialImpact).toBe(true);
  });
});

// ── classifyExecutionQuality — scale extremes ────────────────────────────────

describe("classifyExecutionQuality — scale extremes", () => {
  it("100 (maximum) is Good with no material impact", () => {
    const result = classifyExecutionQuality(QUALITY_SCALE.MAX);
    expect(result.label).toBe("Good");
    expect(result.materialImpact).toBe(false);
  });

  it("0 (minimum) is Poor", () => {
    const result = classifyExecutionQuality(QUALITY_SCALE.MIN);
    expect(result.label).toBe("Poor");
    expect(result.materialImpact).toBe(true);
  });

  it("values above 100 clamp to 100 (Good)", () => {
    expect(classifyExecutionQuality(150).label).toBe("Good");
  });

  it("negative values clamp to 0 (Poor)", () => {
    expect(classifyExecutionQuality(-10).label).toBe("Poor");
  });
});

// ── classifyExecutionQuality — rounding stability ────────────────────────────

describe("classifyExecutionQuality — rounding and near-threshold stability", () => {
  it("69.999… stays Fair — does not round up to Good", () => {
    // JavaScript float precision: 69.99999999 < 70
    expect(classifyExecutionQuality(69.99999999).label).toBe("Fair");
  });

  it("50.000…1 stays Fair — does not round down to Poor", () => {
    expect(classifyExecutionQuality(50.00000001).label).toBe("Fair");
  });

  it("identical scores always yield the same label", () => {
    for (const score of [70, 50, 0, 100, 69.9, 49.9]) {
      const r1 = classifyExecutionQuality(score);
      const r2 = classifyExecutionQuality(score);
      expect(r1.label).toBe(r2.label);
    }
  });
});

// ── formatQualityScore ───────────────────────────────────────────────────────

describe("formatQualityScore", () => {
  it("renders integers with one decimal place", () => {
    expect(formatQualityScore(75)).toBe("75.0");
    expect(formatQualityScore(0)).toBe("0.0");
    expect(formatQualityScore(100)).toBe("100.0");
  });

  it("renders decimals to exactly one place", () => {
    expect(formatQualityScore(69.9)).toBe("69.9");
    expect(formatQualityScore(50.123)).toBe("50.1");
  });
});

// ── classifyFragmentationScore ───────────────────────────────────────────────

describe("classifyFragmentationScore — interior values", () => {
  it("classifies a low fragmentation score", () => {
    expect(classifyFragmentationScore(10)).toBe("Low");
  });

  it("classifies a medium fragmentation score", () => {
    expect(classifyFragmentationScore(50)).toBe("Medium");
  });

  it("classifies a high fragmentation score", () => {
    expect(classifyFragmentationScore(80)).toBe("High");
  });
});

describe("classifyFragmentationScore — Low/Medium boundary at 33", () => {
  it("33 is Low (on threshold — inclusive)", () => {
    expect(classifyFragmentationScore(FRAGMENTATION_THRESHOLDS.LOW_MAX)).toBe("Low");
  });

  it("33.1 is Medium", () => {
    expect(classifyFragmentationScore(33.1)).toBe("Medium");
  });

  it("32.9 is Low", () => {
    expect(classifyFragmentationScore(32.9)).toBe("Low");
  });
});

describe("classifyFragmentationScore — Medium/High boundary at 66", () => {
  it("66 is Medium (on threshold — inclusive)", () => {
    expect(classifyFragmentationScore(FRAGMENTATION_THRESHOLDS.MEDIUM_MAX)).toBe("Medium");
  });

  it("66.1 is High", () => {
    expect(classifyFragmentationScore(66.1)).toBe("High");
  });

  it("65.9 is Medium", () => {
    expect(classifyFragmentationScore(65.9)).toBe("Medium");
  });
});

describe("classifyFragmentationScore — extremes", () => {
  it("0 is Low", () => {
    expect(classifyFragmentationScore(0)).toBe("Low");
  });

  it("100 is High", () => {
    expect(classifyFragmentationScore(100)).toBe("High");
  });
});
