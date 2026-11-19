/**
 * Portfolio exposure heatmap: value at risk per (asset, protocol) pair.
 *
 * `exposureConcentration` grades each dimension on its own — "60% in USDC",
 * "70% on Blend" — but cannot say whether those overlap. The heatmap is the
 * cross-tab behind them: rows are assets, columns are protocols, and each cell
 * is the share of the portfolio held in that asset *on* that protocol. Row and
 * column totals equal the existing per-dimension buckets exactly.
 *
 * Lives in `shared/` so the server endpoint and the client view build and grade
 * the matrix identically.
 */

import {
  resolveConcentrationThresholds,
  type ConcentrationSeverity,
  type ConcentrationThreshold,
  type ConcentrationThresholdsInput,
  type ExposureDimension,
} from "./exposureConcentration";

/** Minimal position shape the heatmap needs. */
export interface ExposureHeatmapPosition {
  asset: string;
  protocol: string;
  /** Current value in USD. Zero-value positions are skipped; negatives are rejected. */
  valueUsd: number;
}

export interface ExposureHeatmapOptions {
  thresholds?: ConcentrationThresholdsInput;
  /** Rows kept before the smallest assets collapse into "Other". Default 8. */
  maxAssets?: number;
  /** Columns kept before the smallest protocols collapse into "Other". Default 8. */
  maxProtocols?: number;
}

export const EXPOSURE_HEATMAP_DEFAULT_MAX_AXIS = 8;
export const EXPOSURE_HEATMAP_MAX_AXIS_LIMIT = 50;
export const EXPOSURE_HEATMAP_MAX_POSITIONS = 1000;
/** Axis key of the collapsed bucket; never collides with a real (trimmed, non-empty) label. */
export const EXPOSURE_HEATMAP_OTHER_KEY = "__other__";

export type ExposureHeatmapErrorCode =
  | "INVALID_POSITION"
  | "TOO_MANY_POSITIONS"
  | "INVALID_OPTIONS";

/** Deterministic, code-tagged failure for invalid or unsupported input. */
export class ExposureHeatmapError extends Error {
  readonly code: ExposureHeatmapErrorCode;
  /** Index of the offending position, for INVALID_POSITION. */
  readonly index?: number;

  constructor(code: ExposureHeatmapErrorCode, message: string, index?: number) {
    super(message);
    this.name = "ExposureHeatmapError";
    this.code = code;
    this.index = index;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** One row (asset) or column (protocol) of the heatmap. */
export interface ExposureHeatmapAxisEntry {
  /** Stable key: the label, or `EXPOSURE_HEATMAP_OTHER_KEY` for the collapsed bucket. */
  key: string;
  label: string;
  valueUsd: number;
  /** Share of total portfolio value, in [0, 1]. */
  share: number;
  /** Graded against this dimension's concentration thresholds. */
  severity: ConcentrationSeverity;
  /** Original labels folded into this entry (more than one only for "Other"). */
  members: string[];
}

export interface ExposureHeatmapCell {
  valueUsd: number;
  share: number;
  severity: ConcentrationSeverity;
}

export interface ExposureHeatmap {
  /** Rows, largest first; "Other" (if any) last. */
  assets: ExposureHeatmapAxisEntry[];
  /** Columns, largest first; "Other" (if any) last. */
  protocols: ExposureHeatmapAxisEntry[];
  /** `cells[row][col]` lines up with `assets[row]` × `protocols[col]`. Absent pairs are zero. */
  cells: ExposureHeatmapCell[][];
  totalValueUsd: number;
  /** Largest single-cell share, in [0, 1]. Drives the color scale. */
  maxCellShare: number;
  /** Worst cell severity. */
  severity: ConcentrationSeverity;
  /** Thresholds cells were graded against (the stricter of asset/protocol). */
  cellThreshold: ConcentrationThreshold;
  /** Positions that contributed value. */
  positionCount: number;
  /** Zero-value positions that were skipped. */
  skippedCount: number;
}

const SEVERITY_RANK: Record<ConcentrationSeverity, number> = { ok: 0, warning: 1, critical: 2 };

function grade(share: number, threshold: ConcentrationThreshold): ConcentrationSeverity {
  if (share > threshold.critical) return "critical";
  if (share > threshold.warn) return "warning";
  return "ok";
}

function resolveAxisLimit(value: number | undefined, field: string): number {
  if (value === undefined) return EXPOSURE_HEATMAP_DEFAULT_MAX_AXIS;
  if (!Number.isInteger(value) || value < 1 || value > EXPOSURE_HEATMAP_MAX_AXIS_LIMIT) {
    throw new ExposureHeatmapError(
      "INVALID_OPTIONS",
      `${field} must be an integer between 1 and ${EXPOSURE_HEATMAP_MAX_AXIS_LIMIT}.`,
    );
  }
  return value;
}

function validatePosition(raw: unknown, index: number): ExposureHeatmapPosition {
  if (typeof raw !== "object" || raw === null) {
    throw new ExposureHeatmapError("INVALID_POSITION", `Position #${index} must be an object.`, index);
  }
  const { asset, protocol, valueUsd } = raw as Record<string, unknown>;
  if (typeof asset !== "string" || asset.trim() === "") {
    throw new ExposureHeatmapError(
      "INVALID_POSITION",
      `Position #${index} requires a non-empty string \`asset\`.`,
      index,
    );
  }
  if (typeof protocol !== "string" || protocol.trim() === "") {
    throw new ExposureHeatmapError(
      "INVALID_POSITION",
      `Position #${index} requires a non-empty string \`protocol\`.`,
      index,
    );
  }
  if (typeof valueUsd !== "number" || !Number.isFinite(valueUsd) || valueUsd < 0) {
    throw new ExposureHeatmapError(
      "INVALID_POSITION",
      `Position #${index} requires a finite, non-negative \`valueUsd\`.`,
      index,
    );
  }
  return { asset: asset.trim(), protocol: protocol.trim(), valueUsd };
}

/** Largest first, ties broken by label so output is stable across input orderings. */
function byValueDesc(a: [string, number], b: [string, number]): number {
  return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

/**
 * Keeps the `limit` largest labels; when there are more, the top `limit - 1`
 * stay and the rest fold into one "Other" entry so the axis never exceeds
 * `limit`. Returns label → axis key.
 */
function buildAxis(
  totals: Map<string, number>,
  limit: number,
  totalValueUsd: number,
  threshold: ConcentrationThreshold,
): { entries: ExposureHeatmapAxisEntry[]; keyOf: Map<string, string> } {
  const sorted = [...totals.entries()].sort(byValueDesc);
  const keep = sorted.length > limit ? sorted.slice(0, limit - 1) : sorted;
  const folded = sorted.length > limit ? sorted.slice(limit - 1) : [];

  const keyOf = new Map<string, string>();
  const share = (v: number) => (totalValueUsd > 0 ? Math.min(1, v / totalValueUsd) : 0);

  const entries: ExposureHeatmapAxisEntry[] = keep.map(([label, valueUsd]) => {
    keyOf.set(label, label);
    return {
      key: label,
      label,
      valueUsd,
      share: share(valueUsd),
      severity: grade(share(valueUsd), threshold),
      members: [label],
    };
  });

  if (folded.length > 0) {
    const valueUsd = folded.reduce((sum, [, v]) => sum + v, 0);
    for (const [label] of folded) keyOf.set(label, EXPOSURE_HEATMAP_OTHER_KEY);
    entries.push({
      key: EXPOSURE_HEATMAP_OTHER_KEY,
      label: "Other",
      valueUsd,
      share: share(valueUsd),
      severity: grade(share(valueUsd), threshold),
      members: folded.map(([label]) => label),
    });
  }

  return { entries, keyOf };
}

/**
 * Builds the asset × protocol exposure heatmap.
 *
 * An empty or all-zero portfolio yields an empty heatmap (not an error), so
 * callers can render an empty state. Invalid input throws
 * {@link ExposureHeatmapError} with a stable code.
 *
 * Cells are graded against the stricter of the asset and protocol thresholds:
 * a cell is simultaneously part of one asset and one protocol, so it breaches
 * whichever limit it crosses first.
 */
export function buildExposureHeatmap(
  positions: readonly unknown[],
  options: ExposureHeatmapOptions = {},
): ExposureHeatmap {
  if (!Array.isArray(positions)) {
    throw new ExposureHeatmapError("INVALID_POSITION", "Positions must be an array.");
  }
  if (positions.length > EXPOSURE_HEATMAP_MAX_POSITIONS) {
    throw new ExposureHeatmapError(
      "TOO_MANY_POSITIONS",
      `At most ${EXPOSURE_HEATMAP_MAX_POSITIONS} positions are supported (got ${positions.length}).`,
    );
  }

  const maxAssets = resolveAxisLimit(options.maxAssets, "maxAssets");
  const maxProtocols = resolveAxisLimit(options.maxProtocols, "maxProtocols");
  const thresholds = resolveConcentrationThresholds(options.thresholds);
  const cellThreshold: ConcentrationThreshold = {
    warn: Math.min(thresholds.asset.warn, thresholds.protocol.warn),
    critical: Math.min(thresholds.asset.critical, thresholds.protocol.critical),
  };

  const assetTotals = new Map<string, number>();
  const protocolTotals = new Map<string, number>();
  const pairTotals = new Map<string, Map<string, number>>();
  let totalValueUsd = 0;
  let positionCount = 0;
  let skippedCount = 0;

  positions.forEach((raw, index) => {
    const { asset, protocol, valueUsd } = validatePosition(raw, index);
    if (valueUsd === 0) {
      skippedCount += 1;
      return;
    }
    positionCount += 1;
    totalValueUsd += valueUsd;
    assetTotals.set(asset, (assetTotals.get(asset) ?? 0) + valueUsd);
    protocolTotals.set(protocol, (protocolTotals.get(protocol) ?? 0) + valueUsd);
    const row = pairTotals.get(asset) ?? new Map<string, number>();
    row.set(protocol, (row.get(protocol) ?? 0) + valueUsd);
    pairTotals.set(asset, row);
  });

  const assetAxis = buildAxis(assetTotals, maxAssets, totalValueUsd, thresholds.asset);
  const protocolAxis = buildAxis(protocolTotals, maxProtocols, totalValueUsd, thresholds.protocol);

  const rowIndex = new Map(assetAxis.entries.map((e, i) => [e.key, i]));
  const colIndex = new Map(protocolAxis.entries.map((e, i) => [e.key, i]));
  const values: number[][] = assetAxis.entries.map(() => protocolAxis.entries.map(() => 0));

  for (const [asset, row] of pairTotals) {
    const r = rowIndex.get(assetAxis.keyOf.get(asset)!)!;
    for (const [protocol, valueUsd] of row) {
      const c = colIndex.get(protocolAxis.keyOf.get(protocol)!)!;
      values[r][c] += valueUsd;
    }
  }

  let maxCellShare = 0;
  let severity: ConcentrationSeverity = "ok";
  const cells: ExposureHeatmapCell[][] = values.map((row) =>
    row.map((valueUsd) => {
      const share = totalValueUsd > 0 ? Math.min(1, valueUsd / totalValueUsd) : 0;
      const cellSeverity = grade(share, cellThreshold);
      maxCellShare = Math.max(maxCellShare, share);
      if (SEVERITY_RANK[cellSeverity] > SEVERITY_RANK[severity]) severity = cellSeverity;
      return { valueUsd, share, severity: cellSeverity };
    }),
  );

  return {
    assets: assetAxis.entries,
    protocols: protocolAxis.entries,
    cells,
    totalValueUsd,
    maxCellShare,
    severity,
    cellThreshold,
    positionCount,
    skippedCount,
  };
}

export type { ConcentrationSeverity, ExposureDimension };
