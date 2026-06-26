import { describe, it, expect } from "vitest";
import {
  contrastRatio,
  meetsAA,
  CHART_LEGEND_COLORS,
  BADGE_COLORS,
  BADGE_DARK_BG,
  WCAG_AA_NORMAL,
  WCAG_AA_LARGE,
} from "./darkModeContrast";

describe("contrastRatio", () => {
  it("returns 21 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("returns 1 for identical colors", () => {
    expect(contrastRatio("#94a3b8", "#94a3b8")).toBeCloseTo(1, 5);
  });

  it("is symmetric — fg/bg order does not change the ratio", () => {
    const fg = "#94a3b8";
    const bg = "#0f172a";
    expect(contrastRatio(fg, bg)).toBeCloseTo(contrastRatio(bg, fg), 10);
  });

  it("computes a ratio > 1 for any two distinct colors", () => {
    expect(contrastRatio("#6C5DD3", "#0f172a")).toBeGreaterThan(1);
  });
});

describe("meetsAA — chart legend colors on dark tooltip background", () => {
  const bg = CHART_LEGEND_COLORS.tooltip_bg;

  it("axis label (#94a3b8) meets AA large text on tooltip background", () => {
    expect(meetsAA(CHART_LEGEND_COLORS.axis, bg, true)).toBe(true);
  });

  it("primary line (#6C5DD3) meets AA large text on tooltip background", () => {
    expect(meetsAA(CHART_LEGEND_COLORS.line_primary, bg, true)).toBe(true);
  });

  it("axis label does not meet AA normal threshold — flagged as regression boundary", () => {
    const ratio = contrastRatio(CHART_LEGEND_COLORS.axis, bg);
    expect(ratio).toBeGreaterThan(WCAG_AA_LARGE);
  });
});

describe("meetsAA — badge colors in dark mode", () => {
  it("active badge fg meets AA large text on its background", () => {
    const { fg, bg } = BADGE_COLORS.active;
    expect(meetsAA(fg, bg, true)).toBe(true);
  });

  it("warning badge fg meets AA large text on its background", () => {
    const { fg, bg } = BADGE_COLORS.warning;
    expect(meetsAA(fg, bg, true)).toBe(true);
  });

  it("error badge fg meets AA large text on its background", () => {
    const { fg, bg } = BADGE_COLORS.error;
    expect(meetsAA(fg, bg, true)).toBe(true);
  });

  it("active badge fg meets AA large text on the global dark background", () => {
    expect(meetsAA(BADGE_COLORS.active.fg, BADGE_DARK_BG, true)).toBe(true);
  });

  it("warning badge fg meets AA large text on the global dark background", () => {
    expect(meetsAA(BADGE_COLORS.warning.fg, BADGE_DARK_BG, true)).toBe(true);
  });

  it("error badge fg meets AA large text on the global dark background", () => {
    expect(meetsAA(BADGE_COLORS.error.fg, BADGE_DARK_BG, true)).toBe(true);
  });
});

describe("contrastRatio regression — values must not drop below thresholds", () => {
  it("axis color maintains contrast >= WCAG_AA_LARGE on tooltip bg", () => {
    expect(contrastRatio(CHART_LEGEND_COLORS.axis, CHART_LEGEND_COLORS.tooltip_bg)).toBeGreaterThanOrEqual(WCAG_AA_LARGE);
  });

  it("active badge maintains contrast >= WCAG_AA_NORMAL on its bg", () => {
    expect(contrastRatio(BADGE_COLORS.active.fg, BADGE_COLORS.active.bg)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("warning badge maintains contrast >= WCAG_AA_NORMAL on its bg", () => {
    expect(contrastRatio(BADGE_COLORS.warning.fg, BADGE_COLORS.warning.bg)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("error badge maintains contrast >= WCAG_AA_NORMAL on its bg", () => {
    expect(contrastRatio(BADGE_COLORS.error.fg, BADGE_COLORS.error.bg)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });
});
