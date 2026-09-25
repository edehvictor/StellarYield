/**
 * Shared exposure concentration model.
 *
 * A portfolio spread across many positions can still be dangerously concentrated
 * in a single asset or a single protocol. This module turns raw exposure buckets
 * (value in USD keyed by asset or protocol) into shares of the portfolio, grades
 * them against configurable thresholds, and produces the warnings rendered by the
 * exposure map and portfolio summary views.
 *
 * The calculation lives in `shared/` so the server (portfolio + reconciliation
 * services) and the client (exposure map) grade concentration identically.
 */

export type ExposureDimension = "asset" | "protocol";

/** Severity of a single exposure bucket, ordered from safest to most severe. */
export type ConcentrationSeverity = "ok" | "warning" | "critical";

/** Warn/critical cutoffs for one dimension, expressed as shares in (0, 1]. */
export interface ConcentrationThreshold {
  /** Share above which a bucket is flagged as a warning. */
  warn: number;
  /** Share above which a bucket is flagged as critical. */
  critical: number;
}

/** Threshold configuration for every dimension the analyzer grades. */
export interface ConcentrationThresholds {
  asset: ConcentrationThreshold;
  protocol: ConcentrationThreshold;
}

/** Caller-supplied overrides; any omitted field falls back to the default. */
export type ConcentrationThresholdsInput = {
  [D in ExposureDimension]?: Partial<ConcentrationThreshold>;
};

/**
 * Defaults tuned so a balanced two-way split (50/50) stays clean: a bucket must
 * exceed half the portfolio to warn, and dominate it outright to be critical.
 */
export const DEFAULT_CONCENTRATION_THRESHOLDS: ConcentrationThresholds = {
  asset: { warn: 0.5, critical: 0.85 },
  protocol: { warn: 0.5, critical: 0.85 },
};

/** One exposure bucket graded against its dimension's thresholds. */
export interface ConcentrationEntry {
  dimension: ExposureDimension;
  /** Asset symbol or protocol name. */
  name: string;
  valueUsd: number;
  /** Share of total portfolio value, in [0, 1]. */
  share: number;
  severity: ConcentrationSeverity;
  /** Thresholds this entry was graded against. */
  threshold: ConcentrationThreshold;
}

/** A graded bucket that breached at least the warn threshold. */
export interface ConcentrationWarning extends ConcentrationEntry {
  severity: Exclude<ConcentrationSeverity, "ok">;
  /** Human-readable summary, e.g. "High concentration in USDC (80%)". */
  message: string;
}

export interface ConcentrationAnalysis {
  /** Every bucket, both dimensions, sorted by descending share. */
  entries: ConcentrationEntry[];
  /** Breaching buckets only, most severe (then largest) first. */
  warnings: ConcentrationWarning[];
  /** Warning messages only — convenient for legacy string-list consumers. */
  messages: string[];
  /** Worst severity across all buckets. */
  severity: ConcentrationSeverity;
  /** Largest single-asset share, in [0, 1]. */
  topAssetShare: number;
  /** Largest single-protocol share, in [0, 1]. */
  topProtocolShare: number;
  totalValueUsd: number;
  /** Thresholds the analysis was run with, after defaults were applied. */
  thresholds: ConcentrationThresholds;
}

const SEVERITY_RANK: Record<ConcentrationSeverity, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
};

/** True when `a` is at least as severe as `b`. */
export function isAtLeastAsSevere(
  a: ConcentrationSeverity,
  b: ConcentrationSeverity,
): boolean {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b];
}

function clampShare(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 1);
}

/**
 * Normalizes a single threshold pair: drops non-finite or out-of-range values in
 * favour of the default, and keeps `critical` from sitting below `warn` (an
 * inverted pair would make the critical tier unreachable).
 */
function resolveThreshold(
  fallback: ConcentrationThreshold,
  override?: Partial<ConcentrationThreshold>,
): ConcentrationThreshold {
  const isValid = (value: number | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;

  const warn = isValid(override?.warn) ? override.warn : fallback.warn;
  const critical = isValid(override?.critical) ? override.critical : fallback.critical;

  return { warn, critical: Math.max(warn, critical) };
}

/** Merges caller overrides onto the defaults, validating each value. */
export function resolveConcentrationThresholds(
  input?: ConcentrationThresholdsInput,
  defaults: ConcentrationThresholds = DEFAULT_CONCENTRATION_THRESHOLDS,
): ConcentrationThresholds {
  return {
    asset: resolveThreshold(defaults.asset, input?.asset),
    protocol: resolveThreshold(defaults.protocol, input?.protocol),
  };
}

function gradeShare(
  share: number,
  threshold: ConcentrationThreshold,
): ConcentrationSeverity {
  if (share > threshold.critical) return "critical";
  if (share > threshold.warn) return "warning";
  return "ok";
}

/**
 * Builds the warning copy. The wording is stable across severities so the two
 * tiers read as one family, and protocol warnings name the dimension to keep
 * them unambiguous when an asset and a protocol share a name.
 */
export function formatConcentrationMessage(
  entry: ConcentrationEntry,
  severity: Exclude<ConcentrationSeverity, "ok">,
): string {
  const label = severity === "critical" ? "Critical concentration" : "High concentration";
  const suffix = entry.dimension === "protocol" ? " protocol" : "";
  return `${label} in ${entry.name}${suffix} (${formatSharePct(entry.share)})`;
}

/** Formats a share in [0, 1] as a rounded percentage string, e.g. "80%". */
export function formatSharePct(share: number, fractionDigits = 0): string {
  return `${(share * 100).toFixed(fractionDigits)}%`;
}

function buildEntries(
  dimension: ExposureDimension,
  buckets: Record<string, number>,
  totalValueUsd: number,
  threshold: ConcentrationThreshold,
): ConcentrationEntry[] {
  return Object.entries(buckets ?? {})
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([name, valueUsd]) => {
      const share = totalValueUsd > 0 ? clampShare(valueUsd / totalValueUsd) : 0;
      return {
        dimension,
        name,
        valueUsd,
        share,
        severity: gradeShare(share, threshold),
        threshold,
      };
    });
}

export interface ConcentrationInput {
  byAsset: Record<string, number>;
  byProtocol: Record<string, number>;
  /**
   * Portfolio total. Defaults to the sum of the asset buckets, which is the
   * right denominator whenever every position is counted exactly once per
   * dimension. Pass it explicitly when the caller already tracks the total.
   */
  totalValueUsd?: number;
}

/**
 * Grades asset and protocol exposure against the (optionally overridden)
 * thresholds. Safe on empty or zero-value portfolios: everything comes back
 * empty with severity "ok" rather than dividing by zero.
 */
export function analyzeConcentration(
  input: ConcentrationInput,
  thresholds?: ConcentrationThresholdsInput,
): ConcentrationAnalysis {
  const resolved = resolveConcentrationThresholds(thresholds);
  const byAsset = input.byAsset ?? {};
  const byProtocol = input.byProtocol ?? {};

  const sumOfAssets = Object.values(byAsset).reduce(
    (sum, value) => (Number.isFinite(value) && value > 0 ? sum + value : sum),
    0,
  );
  const declaredTotal = input.totalValueUsd;
  const totalValueUsd =
    typeof declaredTotal === "number" && Number.isFinite(declaredTotal) && declaredTotal > 0
      ? declaredTotal
      : sumOfAssets;

  const entries = [
    ...buildEntries("asset", byAsset, totalValueUsd, resolved.asset),
    ...buildEntries("protocol", byProtocol, totalValueUsd, resolved.protocol),
  ].sort((a, b) => b.share - a.share);

  const warnings: ConcentrationWarning[] = entries
    .filter((entry) => entry.severity !== "ok")
    .map((entry) => {
      const severity = entry.severity as Exclude<ConcentrationSeverity, "ok">;
      return { ...entry, severity, message: formatConcentrationMessage(entry, severity) };
    })
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.share - a.share);

  const topShare = (dimension: ExposureDimension) =>
    entries.reduce(
      (max, entry) => (entry.dimension === dimension ? Math.max(max, entry.share) : max),
      0,
    );

  return {
    entries,
    warnings,
    messages: warnings.map((warning) => warning.message),
    severity: warnings.reduce<ConcentrationSeverity>(
      (worst, warning) => (isAtLeastAsSevere(warning.severity, worst) ? warning.severity : worst),
      "ok",
    ),
    topAssetShare: topShare("asset"),
    topProtocolShare: topShare("protocol"),
    totalValueUsd,
    thresholds: resolved,
  };
}

/** Aggregates positions into the exposure buckets `analyzeConcentration` expects. */
export function buildExposureBuckets<T>(
  positions: readonly T[],
  select: (position: T) => { asset: string; protocol: string; valueUsd: number },
): { byAsset: Record<string, number>; byProtocol: Record<string, number>; totalValueUsd: number } {
  const byAsset: Record<string, number> = {};
  const byProtocol: Record<string, number> = {};
  let totalValueUsd = 0;

  for (const position of positions) {
    const { asset, protocol, valueUsd } = select(position);
    if (!Number.isFinite(valueUsd) || valueUsd <= 0) continue;

    totalValueUsd += valueUsd;
    if (asset) byAsset[asset] = (byAsset[asset] ?? 0) + valueUsd;
    if (protocol) byProtocol[protocol] = (byProtocol[protocol] ?? 0) + valueUsd;
  }

  return { byAsset, byProtocol, totalValueUsd };
}
