export const CHART_LEGEND_COLORS = {
  axis: "#94a3b8",
  tooltip_bg: "#0f172a",
  line_primary: "#6C5DD3",
  tooltip_border: "#334155",
} as const;

export const BADGE_DARK_BG = "#0f172a";

export const BADGE_COLORS = {
  active: { fg: "#34d399", bg: "#052e16" },
  warning: { fg: "#fbbf24", bg: "#1a0f00" },
  error: { fg: "#f87171", bg: "#1c0a0a" },
} as const;

type HexColor = string;

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

export function contrastRatio(fg: HexColor, bg: HexColor): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export const WCAG_AA_NORMAL = 4.5;
export const WCAG_AA_LARGE = 3.0;

export function meetsAA(fg: HexColor, bg: HexColor, large = false): boolean {
  return contrastRatio(fg, bg) >= (large ? WCAG_AA_LARGE : WCAG_AA_NORMAL);
}
