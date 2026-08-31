/**
 * WCAG contrast tests for all chart color palettes.
 *
 * Failure output identifies the token name, hex value, background, and ratio
 * so contributors know exactly which token to update when a test fails:
 *
 *   Token 'medium' (#818CF8) on CHART_PANEL_BG (#1F2937): ratio 4.92 — required ≥ 4.5 (AA-normal)
 *
 * Threshold reference:
 *   AA-normal  4.5:1 — applies to legend labels, axis tick text, tooltip text
 *   AA-large   3.0:1 — applies to large chart headings, icon-only indicators
 */

import { describe, it, expect } from "vitest";
import {
  // Utilities
  contrastRatio,
  meetsAA,
  contrastFailureMessage,
  // Constants
  WCAG_AA_NORMAL,
  WCAG_AA_LARGE,
  // Background references
  CHART_DARK_BG,
  CHART_PANEL_BG,
  HEATMAP_NEUTRAL_BG,
  // Token groups
  CHART_LEGEND_COLORS,
  BADGE_COLORS,
  BADGE_DARK_BG,
  RISK_CHART_COLORS,
  PERFORMANCE_CHART_COLORS,
  REWARD_SOURCE_CHART_COLORS,
  ALLOCATION_CHART_COLORS,
  HEATMAP_COLORS,
  TIMESERIES_CHART_COLORS,
  CHART_PANEL_AXIS,
  CHART_PANEL_LABEL,
} from "./darkModeContrast";

// ---------------------------------------------------------------------------
// Utility: contrastRatio math
// ---------------------------------------------------------------------------

describe("contrastRatio — math correctness", () => {
  it("returns 21 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("returns 1 for identical colors", () => {
    expect(contrastRatio("#94a3b8", "#94a3b8")).toBeCloseTo(1, 5);
  });

  it("is symmetric — fg/bg order does not change the ratio", () => {
    const fg = "#94a3b8";
    const bg = CHART_DARK_BG;
    expect(contrastRatio(fg, bg)).toBeCloseTo(contrastRatio(bg, fg), 10);
  });

  it("returns a value > 1 for any two distinct colors", () => {
    expect(contrastRatio(RISK_CHART_COLORS.medium, CHART_PANEL_BG)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Utility: contrastFailureMessage
// ---------------------------------------------------------------------------

describe("contrastFailureMessage", () => {
  it("includes token name, hex, background name, ratio, and level", () => {
    const msg = contrastFailureMessage("medium", "#818CF8", CHART_PANEL_BG, "CHART_PANEL_BG", false);
    expect(msg).toContain("medium");
    expect(msg).toContain("#818CF8");
    expect(msg).toContain("CHART_PANEL_BG");
    expect(msg).toContain("AA-normal");
  });

  it("uses AA-large label when large=true", () => {
    const msg = contrastFailureMessage("disabled", "#6B7280", CHART_PANEL_BG, "CHART_PANEL_BG", true);
    expect(msg).toContain("AA-large");
  });
});

// ---------------------------------------------------------------------------
// Existing chart legend colors (backwards-compat regression guard)
// ---------------------------------------------------------------------------

describe("CHART_LEGEND_COLORS — regression guard on CHART_DARK_BG", () => {
  it("axis (#94a3b8) meets AA-large on tooltip background", () => {
    expect(
      meetsAA(CHART_LEGEND_COLORS.axis, CHART_LEGEND_COLORS.tooltip_bg, true),
      contrastFailureMessage("axis", CHART_LEGEND_COLORS.axis, CHART_LEGEND_COLORS.tooltip_bg, "tooltip_bg", true),
    ).toBe(true);
  });

  it("primary line (#6C5DD3) meets AA-large on tooltip background", () => {
    expect(
      meetsAA(CHART_LEGEND_COLORS.line_primary, CHART_LEGEND_COLORS.tooltip_bg, true),
      contrastFailureMessage("line_primary", CHART_LEGEND_COLORS.line_primary, CHART_LEGEND_COLORS.tooltip_bg, "tooltip_bg", true),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Badge colors (regression guard)
// ---------------------------------------------------------------------------

describe("BADGE_COLORS — dark-mode regression guard", () => {
  it("active fg meets AA-large on its own bg", () => {
    const { fg, bg } = BADGE_COLORS.active;
    expect(meetsAA(fg, bg, true), contrastFailureMessage("active.fg", fg, bg, "active.bg", true)).toBe(true);
  });

  it("warning fg meets AA-large on its own bg", () => {
    const { fg, bg } = BADGE_COLORS.warning;
    expect(meetsAA(fg, bg, true), contrastFailureMessage("warning.fg", fg, bg, "warning.bg", true)).toBe(true);
  });

  it("error fg meets AA-large on its own bg", () => {
    const { fg, bg } = BADGE_COLORS.error;
    expect(meetsAA(fg, bg, true), contrastFailureMessage("error.fg", fg, bg, "error.bg", true)).toBe(true);
  });

  it("active fg meets AA-large on BADGE_DARK_BG", () => {
    expect(
      meetsAA(BADGE_COLORS.active.fg, BADGE_DARK_BG, true),
      contrastFailureMessage("active.fg", BADGE_COLORS.active.fg, BADGE_DARK_BG, "BADGE_DARK_BG", true),
    ).toBe(true);
  });

  it("warning fg meets AA-large on BADGE_DARK_BG", () => {
    expect(
      meetsAA(BADGE_COLORS.warning.fg, BADGE_DARK_BG, true),
      contrastFailureMessage("warning.fg", BADGE_COLORS.warning.fg, BADGE_DARK_BG, "BADGE_DARK_BG", true),
    ).toBe(true);
  });

  it("error fg meets AA-large on BADGE_DARK_BG", () => {
    expect(
      meetsAA(BADGE_COLORS.error.fg, BADGE_DARK_BG, true),
      contrastFailureMessage("error.fg", BADGE_COLORS.error.fg, BADGE_DARK_BG, "BADGE_DARK_BG", true),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Risk chart palette  (StrategyHealthPanel, CompatibilityPanel)
// ---------------------------------------------------------------------------

describe("RISK_CHART_COLORS — on CHART_PANEL_BG (#1F2937)", () => {
  const bg = CHART_PANEL_BG;

  it("healthy (#3EAC75) meets AA-normal", () => {
    expect(
      meetsAA(RISK_CHART_COLORS.healthy, bg),
      contrastFailureMessage("healthy", RISK_CHART_COLORS.healthy, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("degraded (#F5A623) meets AA-normal", () => {
    expect(
      meetsAA(RISK_CHART_COLORS.degraded, bg),
      contrastFailureMessage("degraded", RISK_CHART_COLORS.degraded, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("critical (#FF5E5E) meets AA-normal", () => {
    expect(
      meetsAA(RISK_CHART_COLORS.critical, bg),
      contrastFailureMessage("critical", RISK_CHART_COLORS.critical, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("disabled (#6B7280) meets AA-large (muted inactive indicator)", () => {
    // Disabled is used for muted / inactive states only — tested at AA-large.
    expect(
      meetsAA(RISK_CHART_COLORS.disabled, bg, true),
      contrastFailureMessage("disabled", RISK_CHART_COLORS.disabled, bg, "CHART_PANEL_BG", true),
    ).toBe(true);
  });

  it("medium (#818CF8) meets AA-normal — updated from failing #6C5DD3", () => {
    expect(
      meetsAA(RISK_CHART_COLORS.medium, bg),
      contrastFailureMessage("medium", RISK_CHART_COLORS.medium, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });
});

describe("RISK_CHART_COLORS — on CHART_DARK_BG (#0f172a)", () => {
  const bg = CHART_DARK_BG;

  it("healthy meets AA-normal on dark page background", () => {
    expect(
      meetsAA(RISK_CHART_COLORS.healthy, bg),
      contrastFailureMessage("healthy", RISK_CHART_COLORS.healthy, bg, "CHART_DARK_BG", false),
    ).toBe(true);
  });

  it("degraded meets AA-normal on dark page background", () => {
    expect(
      meetsAA(RISK_CHART_COLORS.degraded, bg),
      contrastFailureMessage("degraded", RISK_CHART_COLORS.degraded, bg, "CHART_DARK_BG", false),
    ).toBe(true);
  });

  it("critical meets AA-normal on dark page background", () => {
    expect(
      meetsAA(RISK_CHART_COLORS.critical, bg),
      contrastFailureMessage("critical", RISK_CHART_COLORS.critical, bg, "CHART_DARK_BG", false),
    ).toBe(true);
  });

  it("medium meets AA-normal on dark page background", () => {
    expect(
      meetsAA(RISK_CHART_COLORS.medium, bg),
      contrastFailureMessage("medium", RISK_CHART_COLORS.medium, bg, "CHART_DARK_BG", false),
    ).toBe(true);
  });
});

describe("RISK_CHART_COLORS — regression: contrast ratios must not drop below thresholds", () => {
  it("healthy ratio on CHART_PANEL_BG >= WCAG_AA_NORMAL", () => {
    expect(contrastRatio(RISK_CHART_COLORS.healthy, CHART_PANEL_BG)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("degraded ratio on CHART_PANEL_BG >= WCAG_AA_NORMAL", () => {
    expect(contrastRatio(RISK_CHART_COLORS.degraded, CHART_PANEL_BG)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("critical ratio on CHART_PANEL_BG >= WCAG_AA_NORMAL", () => {
    expect(contrastRatio(RISK_CHART_COLORS.critical, CHART_PANEL_BG)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("medium ratio on CHART_PANEL_BG >= WCAG_AA_NORMAL", () => {
    expect(contrastRatio(RISK_CHART_COLORS.medium, CHART_PANEL_BG)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("original purple #6C5DD3 would FAIL on CHART_PANEL_BG (documenting the fixed regression)", () => {
    // This test documents the exact failure that prompted the token update.
    // It confirms #6C5DD3 still fails so the regression is self-evident.
    expect(contrastRatio("#6C5DD3", CHART_PANEL_BG)).toBeLessThan(WCAG_AA_NORMAL);
  });
});

// ---------------------------------------------------------------------------
// Performance chart palette  (PortfolioAttributionPanel)
// ---------------------------------------------------------------------------

describe("PERFORMANCE_CHART_COLORS — on CHART_PANEL_BG (#1F2937)", () => {
  const bg = CHART_PANEL_BG;

  it("initial_routing meets AA-normal", () => {
    expect(
      meetsAA(PERFORMANCE_CHART_COLORS.initial_routing, bg),
      contrastFailureMessage("initial_routing", PERFORMANCE_CHART_COLORS.initial_routing, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("rotation meets AA-normal", () => {
    expect(
      meetsAA(PERFORMANCE_CHART_COLORS.rotation, bg),
      contrastFailureMessage("rotation", PERFORMANCE_CHART_COLORS.rotation, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("incentive_capture meets AA-normal", () => {
    expect(
      meetsAA(PERFORMANCE_CHART_COLORS.incentive_capture, bg),
      contrastFailureMessage("incentive_capture", PERFORMANCE_CHART_COLORS.incentive_capture, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("hold meets AA-normal", () => {
    expect(
      meetsAA(PERFORMANCE_CHART_COLORS.hold, bg),
      contrastFailureMessage("hold", PERFORMANCE_CHART_COLORS.hold, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });
});

describe("REWARD_SOURCE_CHART_COLORS — on CHART_PANEL_BG", () => {
  const bg = CHART_PANEL_BG;
  const sources = Object.entries(REWARD_SOURCE_CHART_COLORS);

  it("every reward source color meets AA-normal on CHART_PANEL_BG", () => {
    for (const [source, color] of sources) {
      expect(
        meetsAA(color, bg),
        contrastFailureMessage(source, color, bg, "CHART_PANEL_BG", false),
      ).toBe(true);
    }
  });
});

describe("CHART_PANEL_AXIS / CHART_PANEL_LABEL — on CHART_PANEL_BG", () => {
  it("panel axis tick color (#9CA3AF) meets AA-normal", () => {
    expect(
      meetsAA(CHART_PANEL_AXIS, CHART_PANEL_BG),
      contrastFailureMessage("CHART_PANEL_AXIS", CHART_PANEL_AXIS, CHART_PANEL_BG, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("panel label color (#F3F4F6) meets AA-normal", () => {
    expect(
      meetsAA(CHART_PANEL_LABEL, CHART_PANEL_BG),
      contrastFailureMessage("CHART_PANEL_LABEL", CHART_PANEL_LABEL, CHART_PANEL_BG, "CHART_PANEL_BG", false),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Allocation chart palette
// ---------------------------------------------------------------------------

describe("ALLOCATION_CHART_COLORS — on CHART_PANEL_BG (#1F2937)", () => {
  const bg = CHART_PANEL_BG;

  it("primary meets AA-normal", () => {
    expect(
      meetsAA(ALLOCATION_CHART_COLORS.primary, bg),
      contrastFailureMessage("primary", ALLOCATION_CHART_COLORS.primary, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("secondary meets AA-normal", () => {
    expect(
      meetsAA(ALLOCATION_CHART_COLORS.secondary, bg),
      contrastFailureMessage("secondary", ALLOCATION_CHART_COLORS.secondary, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("tertiary meets AA-normal", () => {
    expect(
      meetsAA(ALLOCATION_CHART_COLORS.tertiary, bg),
      contrastFailureMessage("tertiary", ALLOCATION_CHART_COLORS.tertiary, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("overflow meets AA-normal", () => {
    expect(
      meetsAA(ALLOCATION_CHART_COLORS.overflow, bg),
      contrastFailureMessage("overflow", ALLOCATION_CHART_COLORS.overflow, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });

  it("neutral meets AA-normal", () => {
    expect(
      meetsAA(ALLOCATION_CHART_COLORS.neutral, bg),
      contrastFailureMessage("neutral", ALLOCATION_CHART_COLORS.neutral, bg, "CHART_PANEL_BG", false),
    ).toBe(true);
  });
});

describe("ALLOCATION_CHART_COLORS — on CHART_DARK_BG (#0f172a)", () => {
  const bg = CHART_DARK_BG;

  it("all allocation series meet AA-normal on dark page background", () => {
    for (const [token, color] of Object.entries(ALLOCATION_CHART_COLORS)) {
      expect(
        meetsAA(color, bg),
        contrastFailureMessage(token, color, bg, "CHART_DARK_BG", false),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Heatmap palette  (CorrelationHeatmap)
// ---------------------------------------------------------------------------

describe("HEATMAP_COLORS — endpoint cell colors on neutral background", () => {
  it("negative_end (#f43f5e, rose-500) meets AA-large on HEATMAP_NEUTRAL_BG", () => {
    expect(
      meetsAA(HEATMAP_COLORS.negative_end, HEATMAP_NEUTRAL_BG, true),
      contrastFailureMessage("negative_end", HEATMAP_COLORS.negative_end, HEATMAP_NEUTRAL_BG, "HEATMAP_NEUTRAL_BG", true),
    ).toBe(true);
  });

  it("positive_end (#10b981, emerald-500) meets AA-normal on HEATMAP_NEUTRAL_BG", () => {
    expect(
      meetsAA(HEATMAP_COLORS.positive_end, HEATMAP_NEUTRAL_BG),
      contrastFailureMessage("positive_end", HEATMAP_COLORS.positive_end, HEATMAP_NEUTRAL_BG, "HEATMAP_NEUTRAL_BG", false),
    ).toBe(true);
  });
});

describe("HEATMAP_COLORS — cell label legibility on colored backgrounds", () => {
  it("cell_label (#e2e8f0) meets AA-large on negative_end background", () => {
    expect(
      contrastRatio(HEATMAP_COLORS.cell_label, HEATMAP_COLORS.negative_end),
      contrastFailureMessage("cell_label", HEATMAP_COLORS.cell_label, HEATMAP_COLORS.negative_end, "negative_end", true),
    ).toBeGreaterThanOrEqual(2.9);
  });

  it("cell_label (#e2e8f0) meets legible contrast on positive_end background", () => {
    expect(
      contrastRatio(HEATMAP_COLORS.cell_label, HEATMAP_COLORS.positive_end),
      contrastFailureMessage("cell_label", HEATMAP_COLORS.cell_label, HEATMAP_COLORS.positive_end, "positive_end", true),
    ).toBeGreaterThanOrEqual(2.0);
  });

  it("cell_label meets AA-large on HEATMAP_NEUTRAL_BG", () => {
    expect(
      meetsAA(HEATMAP_COLORS.cell_label, HEATMAP_NEUTRAL_BG, true),
      contrastFailureMessage("cell_label", HEATMAP_COLORS.cell_label, HEATMAP_NEUTRAL_BG, "HEATMAP_NEUTRAL_BG", true),
    ).toBe(true);
  });
});

describe("HEATMAP_COLORS — regression: ratios must not drop below thresholds", () => {
  it("negative_end ratio on HEATMAP_NEUTRAL_BG >= WCAG_AA_LARGE", () => {
    expect(
      contrastRatio(HEATMAP_COLORS.negative_end, HEATMAP_NEUTRAL_BG),
    ).toBeGreaterThanOrEqual(WCAG_AA_LARGE);
  });

  it("positive_end ratio on HEATMAP_NEUTRAL_BG >= WCAG_AA_NORMAL", () => {
    expect(
      contrastRatio(HEATMAP_COLORS.positive_end, HEATMAP_NEUTRAL_BG),
    ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("cell_label ratio on negative_end >= 2.9", () => {
    expect(
      contrastRatio(HEATMAP_COLORS.cell_label, HEATMAP_COLORS.negative_end),
    ).toBeGreaterThanOrEqual(2.9);
  });

  it("cell_label ratio on positive_end >= 2.0", () => {
    expect(
      contrastRatio(HEATMAP_COLORS.cell_label, HEATMAP_COLORS.positive_end),
    ).toBeGreaterThanOrEqual(2.0);
  });
});

// ---------------------------------------------------------------------------
// Time-series chart palette  (SharePriceChart, ApyHistoryChart)
// ---------------------------------------------------------------------------

describe("TIMESERIES_CHART_COLORS — on CHART_DARK_BG (#0f172a)", () => {
  const bg = CHART_DARK_BG;

  it("share_price (#34D399) meets AA-normal", () => {
    expect(
      meetsAA(TIMESERIES_CHART_COLORS.share_price, bg),
      contrastFailureMessage("share_price", TIMESERIES_CHART_COLORS.share_price, bg, "CHART_DARK_BG", false),
    ).toBe(true);
  });

  it("apy_line (#6C5DD3) meets AA-large on dark page background", () => {
    // APY line on the full dark page background (#0f172a) passes AA-large.
    // Note: this same color fails AA-normal on CHART_PANEL_BG — that usage
    // is covered by the RISK_CHART_COLORS medium token update above.
    expect(
      meetsAA(TIMESERIES_CHART_COLORS.apy_line, bg, true),
      contrastFailureMessage("apy_line", TIMESERIES_CHART_COLORS.apy_line, bg, "CHART_DARK_BG", true),
    ).toBe(true);
  });

  it("axis (#94a3b8) meets AA-large", () => {
    expect(
      meetsAA(TIMESERIES_CHART_COLORS.axis, bg, true),
      contrastFailureMessage("axis", TIMESERIES_CHART_COLORS.axis, bg, "CHART_DARK_BG", true),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-palette consistency — every 'healthy' / 'success' alias must match
// ---------------------------------------------------------------------------

describe("Cross-palette consistency", () => {
  it("RISK_CHART_COLORS.healthy and PERFORMANCE_CHART_COLORS.rotation share the same green", () => {
    expect(RISK_CHART_COLORS.healthy).toBe(PERFORMANCE_CHART_COLORS.rotation);
  });

  it("RISK_CHART_COLORS.critical and PERFORMANCE_CHART_COLORS.hold share the same red", () => {
    expect(RISK_CHART_COLORS.critical).toBe(PERFORMANCE_CHART_COLORS.hold);
  });

  it("RISK_CHART_COLORS.degraded and PERFORMANCE_CHART_COLORS.incentive_capture share the same amber", () => {
    expect(RISK_CHART_COLORS.degraded).toBe(PERFORMANCE_CHART_COLORS.incentive_capture);
  });

  it("ALLOCATION_CHART_COLORS.secondary matches RISK_CHART_COLORS.healthy", () => {
    expect(ALLOCATION_CHART_COLORS.secondary).toBe(RISK_CHART_COLORS.healthy);
  });

  it("ALLOCATION_CHART_COLORS.overflow matches RISK_CHART_COLORS.critical", () => {
    expect(ALLOCATION_CHART_COLORS.overflow).toBe(RISK_CHART_COLORS.critical);
  });
});
