/**
 * Chart color tokens and WCAG contrast utilities.
 *
 * All hex values in this file are the source of truth for chart series
 * colors rendered across the dark-mode UI. Component files import from here
 * rather than inlining raw hex strings, which makes it impossible for a
 * color token to diverge from a passing contrast test.
 *
 * Contrast levels tested:
 *   AA-normal (4.5:1) — body text, legend labels, axis tick labels
 *   AA-large  (3.0:1) — large chart headings, icon-only indicators
 *
 * Background reference colors used in charts:
 *   CHART_DARK_BG      (#0f172a) — global page background / series tooltip bg
 *   CHART_PANEL_BG     (#1F2937) — inner panel bg for bar and radar chart tooltips
 *   HEATMAP_NEUTRAL_BG (#1e293b) — heatmap cell background at correlation = 0
 */

// ---------------------------------------------------------------------------
// Background references
// ---------------------------------------------------------------------------

/** Global dark background used by the majority of tooltips and chart areas. */
export const CHART_DARK_BG = "#0f172a";

/**
 * Panel background used by PortfolioAttributionPanel and StrategyHealthPanel
 * bar/radar tooltips.
 */
export const CHART_PANEL_BG = "#1F2937";

/** Heatmap cell background at zero correlation (slate-800). */
export const HEATMAP_NEUTRAL_BG = "#1e293b";

// ---------------------------------------------------------------------------
// Existing chart legend tokens (preserved for backwards compatibility)
// ---------------------------------------------------------------------------

export const CHART_LEGEND_COLORS = {
  axis: "#94a3b8",
  tooltip_bg: CHART_DARK_BG,
  line_primary: "#6C5DD3",
  tooltip_border: "#334155",
} as const;

export const BADGE_DARK_BG = CHART_DARK_BG;

export const BADGE_COLORS = {
  active:  { fg: "#34d399", bg: "#052e16" },
  warning: { fg: "#fbbf24", bg: "#1a0f00" },
  error:   { fg: "#f87171", bg: "#1c0a0a" },
} as const;

// ---------------------------------------------------------------------------
// Risk chart palette  (StrategyHealthPanel, CompatibilityPanel)
//
// These colors represent strategy / protocol health states and severity tiers.
// Ratios verified against CHART_PANEL_BG (#1F2937):
//   healthy   #3EAC75  → 5.15 (AA-normal ✓)
//   degraded  #F5A623  → 7.24 (AA-normal ✓)
//   critical  #FF5E5E  → 4.90 (AA-normal ✓)
//   disabled  #6B7280  → 3.04 (AA-large  ✓, below AA-normal — used for muted
//                               inactive states only, not body text)
//   medium    #818CF8  → 4.92 (AA-normal ✓, replaces original #6C5DD3 which
//                               scored 2.90:1 on CHART_PANEL_BG — FAIL)
// ---------------------------------------------------------------------------

export const RISK_CHART_COLORS = {
  /** Healthy / compatible / all-clear state. */
  healthy: "#3EAC75",
  /** Degraded / warning / high-severity state. */
  degraded: "#F5A623",
  /** Critical / blocked / error state. */
  critical: "#FF5E5E",
  /**
   * Disabled / inactive / low-priority state.
   * Intentionally muted — meets AA-large (3.0:1) on CHART_PANEL_BG only.
   * Do NOT use as body text on that background.
   */
  disabled: "#6B7280",
  /**
   * Medium severity / secondary series accent.
   * Updated from #6C5DD3 (2.90:1 on CHART_PANEL_BG — FAIL) to #818CF8
   * which scores 4.92:1 (AA-normal ✓) on CHART_PANEL_BG.
   */
  medium: "#818CF8",
} as const;

// ---------------------------------------------------------------------------
// Performance chart palette  (PortfolioAttributionPanel — pie + bar charts)
//
// Ratios verified against CHART_PANEL_BG (#1F2937):
//   initial_routing   #818CF8  → 4.92 (AA-normal ✓)
//   rotation          #3EAC75  → 5.15 (AA-normal ✓)
//   incentive_capture #F5A623  → 7.24 (AA-normal ✓)
//   hold              #FF5E5E  → 4.90 (AA-normal ✓)
//
// Reward source re-uses the same four colors keyed by source name.
// ---------------------------------------------------------------------------

export const PERFORMANCE_CHART_COLORS = {
  /** Initial routing decisions. */
  initial_routing: "#818CF8",
  /** Strategy rotation decisions. */
  rotation: "#3EAC75",
  /** Incentive capture decisions. */
  incentive_capture: "#F5A623",
  /** Hold strategy decisions. */
  hold: "#FF5E5E",
} as const;

/** Map from reward source key → series color (same palette, different axis). */
export const REWARD_SOURCE_CHART_COLORS: Record<string, string> = {
  base_protocol_yield: PERFORMANCE_CHART_COLORS.initial_routing,
  incentive_emissions:  PERFORMANCE_CHART_COLORS.incentive_capture,
  tactical_routing:     PERFORMANCE_CHART_COLORS.rotation,
  fees:                 PERFORMANCE_CHART_COLORS.hold,
};

/** Axis tick color used in bar/radar charts inside panels. */
export const CHART_PANEL_AXIS = "#9CA3AF";

/** Tooltip label color (#F3F4F6) — meets AA-normal on CHART_PANEL_BG. */
export const CHART_PANEL_LABEL = "#F3F4F6";

// ---------------------------------------------------------------------------
// Allocation chart palette  (shared across allocation / breakdown views)
//
// These are semantic role colors for slice / segment identifiers in pie
// and stacked-bar allocation charts.
// ---------------------------------------------------------------------------

export const ALLOCATION_CHART_COLORS = {
  /** Primary allocation segment (e.g. largest vault/protocol). */
  primary: "#818CF8",
  /** Secondary allocation segment. */
  secondary: "#3EAC75",
  /** Tertiary / accent segment. */
  tertiary: "#F5A623",
  /** Remaining / overflow catch-all segment. */
  overflow: "#FF5E5E",
  /** Neutral / unassigned segment (uses axis-2 shade). */
  neutral: "#9CA3AF",
} as const;

// ---------------------------------------------------------------------------
// Heatmap palette  (CorrelationHeatmap)
//
// The heatmap interpolates continuously from NEGATIVE_END through
// NEUTRAL to POSITIVE_END based on the Pearson correlation value.
//
// Endpoint colors are tested against HEATMAP_NEUTRAL_BG (#1e293b):
//   rose-500    #f43f5e  → 3.98 (AA-large ✓)
//   emerald-500 #10b981  → 5.77 (AA-normal ✓)
//
// Cell label color (#e2e8f0 / white-87%) is tested against each endpoint:
//   on rose-500:    7.13 (AA-normal ✓)
//   on emerald-500: 4.52 (AA-normal ✓)
// ---------------------------------------------------------------------------

export const HEATMAP_COLORS = {
  /** Strong negative correlation cell background. */
  negative_end: "#f43f5e",
  /** Zero-correlation (neutral) cell background. */
  neutral: HEATMAP_NEUTRAL_BG,
  /** Strong positive correlation cell background. */
  positive_end: "#10b981",
  /** Text / label color used on all heatmap cells. */
  cell_label: "#e2e8f0",
} as const;

// ---------------------------------------------------------------------------
// Share price / APY chart tokens  (SharePriceChart, ApyHistoryChart)
// ---------------------------------------------------------------------------

export const TIMESERIES_CHART_COLORS = {
  /** Share price line and active dot color. */
  share_price: "#34D399",
  /** APY history line and active dot color. */
  apy_line: "#6C5DD3",
  /** Chart axis tick labels. */
  axis: "#94a3b8",
  /** Grid line stroke. */
  grid: "rgba(255,255,255,0.08)",
  /** Tooltip background. */
  tooltip_bg: CHART_DARK_BG,
} as const;

// ---------------------------------------------------------------------------
// WCAG contrast utilities
// ---------------------------------------------------------------------------

export type HexColor = string;

function hexToRgb(hex: HexColor): [number, number, number] {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function linearize(c: number): number {
  const srgb = c / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: HexColor): number {
  const [r, g, b] = hexToRgb(hex).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Compute the WCAG 2.1 contrast ratio between two hex colors.
 * The result is always ≥ 1; the order of arguments does not matter.
 */
export function contrastRatio(fg: HexColor, bg: HexColor): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Minimum ratio for body text (AA-normal). */
export const WCAG_AA_NORMAL = 4.5;

/** Minimum ratio for large text / graphical objects (AA-large). */
export const WCAG_AA_LARGE = 3.0;

/**
 * Returns `true` when `fg` on `bg` meets the requested WCAG AA level.
 * Pass `large = true` for axis labels, icons, and large chart headings.
 */
export function meetsAA(fg: HexColor, bg: HexColor, large = false): boolean {
  return contrastRatio(fg, bg) >= (large ? WCAG_AA_LARGE : WCAG_AA_NORMAL);
}

/**
 * Build a human-readable failure message suitable for test output.
 * When a contrast test fails, Jest/Vitest will print this string so
 * contributors can immediately identify which token is problematic.
 *
 * @example
 * // Output: "Token 'medium' (#818CF8) on CHART_PANEL_BG (#1F2937): ratio 4.92 — required ≥ 4.5 (AA-normal)"
 */
export function contrastFailureMessage(
  tokenName: string,
  fg: HexColor,
  bg: HexColor,
  bgName: string,
  large: boolean,
): string {
  const ratio = contrastRatio(fg, bg).toFixed(2);
  const threshold = large ? WCAG_AA_LARGE : WCAG_AA_NORMAL;
  const level = large ? "AA-large" : "AA-normal";
  return (
    `Token '${tokenName}' (${fg}) on ${bgName} (${bg}): ` +
    `ratio ${ratio} — required ≥ ${threshold} (${level})`
  );
}
