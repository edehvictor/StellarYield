import {
  StrategyComparisonCalculationError,
  assertApy,
  assertFeeBps,
  assertRiskScore,
  assertUsdAmount,
  checkedFeeDragBps,
  roundHalfUp,
} from "../../features/strategies/strategyComparisonMath";

export interface StrategyYield {
  protocolName: string;
  apy: number;
  rewardApy: number;
  totalApy: number;
  tvl: number;
  riskScore: number;
  liquidityUsd: number;
  rebalancingBehavior: string;
  managementFeeBps: number;
  performanceFeeBps: number;
  capitalEfficiencyPct: number;
  fetchedAt?: string;
}

export type StrategyComparisonExportFormat = "csv" | "json";

export const STRATEGY_COMPARISON_EXPORT_FIELDS = [
  "generated_at",
  "protocol_name",
  "apy",
  "reward_apy",
  "total_apy",
  "tvl_usd",
  "risk_score",
  "liquidity_usd",
  "fee_drag_bps",
  "management_fee_bps",
  "performance_fee_bps",
  "confidence_score",
  "rebalancing_behavior",
  "fetched_at",
] as const;

export type StrategyComparisonExportField =
  (typeof STRATEGY_COMPARISON_EXPORT_FIELDS)[number];

export type StrategyComparisonExportRow = Record<
  StrategyComparisonExportField,
  string | number
>;

/** Exported numbers are rounded half-up to two decimals (#1922). */
function toExportNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? roundHalfUp(value, 2) : 0;
}

const KNOWN_PROTOCOLS = ["Blend", "Soroswap", "DeFindex"];
const REBALANCING_BEHAVIORS = ["Static", "Dynamic", "Yield-Weighted"];

/** Runs a checked-arithmetic guard and answers false instead of throwing. */
function passes(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch (error) {
    if (error instanceof StrategyComparisonCalculationError) return false;
    throw error;
  }
}

/**
 * Whether an untrusted `/api/yields` entry is safe for the comparison page to
 * render, sort, and export (#1922). Optional fee and efficiency fields are
 * checked only when present; everything the card computes from is required.
 */
export function isComparableStrategy(entry: unknown): entry is StrategyYield {
  if (!entry || typeof entry !== "object") return false;
  const s = entry as Record<string, unknown>;
  if (typeof s.protocolName !== "string" || !KNOWN_PROTOCOLS.includes(s.protocolName)) {
    return false;
  }
  if (
    s.rebalancingBehavior !== undefined &&
    s.rebalancingBehavior !== null &&
    (typeof s.rebalancingBehavior !== "string" ||
      !REBALANCING_BEHAVIORS.includes(s.rebalancingBehavior))
  ) {
    return false;
  }
  const hasFee = (v: unknown) => v !== undefined && v !== null;
  return passes(() => {
    assertApy(s.apy, "apy");
    assertApy(s.totalApy, "totalApy");
    assertUsdAmount(s.tvl, "tvl");
    assertUsdAmount(s.liquidityUsd, "liquidityUsd");
    assertRiskScore(s.riskScore);
    if (hasFee(s.managementFeeBps)) assertFeeBps(s.managementFeeBps, "managementFeeBps");
    if (hasFee(s.performanceFeeBps)) assertFeeBps(s.performanceFeeBps, "performanceFeeBps");
    if (hasFee(s.capitalEfficiencyPct)) {
      const pct = assertApy(s.capitalEfficiencyPct, "capitalEfficiencyPct");
      if (pct < 0 || pct > 100) {
        throw new StrategyComparisonCalculationError("capitalEfficiencyPct must be 0-100");
      }
    }
  });
}

// Validate a single strategy yield entry at the boundary
// Returns the entry if valid, or null if malformed (safe failure)
function validateStrategyYield(entry: unknown): StrategyYield | null {
  if (!entry || typeof entry !== 'object') return null;
  const s = entry as Record<string, unknown>;
  if (typeof s.protocolName !== 'string' || s.protocolName.trim() === '') return null;
  if (typeof s.apy !== 'number' || !Number.isFinite(s.apy)) return null;
  if (typeof s.rewardApy !== 'number' || !Number.isFinite(s.rewardApy)) return null;
  if (typeof s.totalApy !== 'number' || !Number.isFinite(s.totalApy)) return null;
  if (typeof s.tvl !== 'number' || !Number.isFinite(s.tvl)) return null;
  if (typeof s.riskScore !== 'number') return null;
  if (typeof s.liquidityUsd !== 'number' || !Number.isFinite(s.liquidityUsd)) return null;
  if (typeof s.managementFeeBps !== 'number') return null;
  if (typeof s.performanceFeeBps !== 'number') return null;
  if (typeof s.capitalEfficiencyPct !== 'number') return null;
  if (s.rebalancingBehavior !== undefined && 
      s.rebalancingBehavior !== null &&
      (typeof s.rebalancingBehavior !== 'string' ||
        !['Static', 'Dynamic', 'Yield-Weighted'].includes(s.rebalancingBehavior))) return null;
  if (typeof s.fetchedAt !== 'string') return null;
  // Checked boundaries (#1922): non-negative USD, 0-100 risk score, 0-10,000
  // bps per fee with a checked sum, finite APYs.
  if (
    !passes(() => {
      assertApy(s.rewardApy, "rewardApy");
      assertUsdAmount(s.tvl, "tvl");
      assertUsdAmount(s.liquidityUsd, "liquidityUsd");
      assertRiskScore(s.riskScore);
      checkedFeeDragBps(s.managementFeeBps, s.performanceFeeBps);
    })
  ) {
    return null;
  }
  return {
    protocolName: s.protocolName,
    apy: s.apy,
    rewardApy: s.rewardApy,
    totalApy: s.totalApy,
    tvl: s.tvl,
    riskScore: s.riskScore,
    liquidityUsd: s.liquidityUsd,
    rebalancingBehavior: s.rebalancingBehavior || 'Standard',
    managementFeeBps: s.managementFeeBps,
    performanceFeeBps: s.performanceFeeBps,
    capitalEfficiencyPct: s.capitalEfficiencyPct,
    fetchedAt: s.fetchedAt,
  } as StrategyYield;
}

function escapeCsvCell(value: string | number): string {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createStrategyComparisonExportFilename(
  format: StrategyComparisonExportFormat,
  generatedAt = new Date(),
): string {
  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  return `stellaryield-strategy-comparison-${stamp}.${format}`;
}

export function buildStrategyComparisonExportRows(
  strategies: StrategyYield[],
  generatedAt = new Date(),
): StrategyComparisonExportRow[] {
  const generatedAtIso = generatedAt.toISOString();

  // Filter out any malformed entries at build time (safe failure, no mutation)
  const validStrategies = strategies.filter((s) => validateStrategyYield(s) !== null);

  return validStrategies.map((strategy) => {
    const validated = validateStrategyYield(strategy)!;
    const managementFeeBps = validated.managementFeeBps;
    const performanceFeeBps = validated.performanceFeeBps;

    return {
      generated_at: generatedAtIso,
      protocol_name: validated.protocolName,
      apy: toExportNumber(validated.apy),
      reward_apy: toExportNumber(validated.rewardApy),
      total_apy: toExportNumber(validated.totalApy),
      tvl_usd: toExportNumber(validated.tvl),
      risk_score: toExportNumber(validated.riskScore),
      liquidity_usd: toExportNumber(validated.liquidityUsd),
      fee_drag_bps: checkedFeeDragBps(managementFeeBps, performanceFeeBps),
      management_fee_bps: managementFeeBps,
      performance_fee_bps: performanceFeeBps,
      confidence_score: toExportNumber(validated.capitalEfficiencyPct),
      rebalancing_behavior: validated.rebalancingBehavior || "Standard",
      fetched_at: validated.fetchedAt ?? "",
    };
  });
}

export function serializeStrategyComparisonExport(
  strategies: StrategyYield[],
  format: StrategyComparisonExportFormat,
  generatedAt = new Date(),
): string {
  const rows = buildStrategyComparisonExportRows(strategies, generatedAt);

  if (format === "json") {
    return JSON.stringify(
      {
        generated_at: generatedAt.toISOString(),
        row_count: rows.length,
        fields: STRATEGY_COMPARISON_EXPORT_FIELDS,
        strategies: rows,
      },
      null,
      2,
    );
  }

  const header = STRATEGY_COMPARISON_EXPORT_FIELDS.join(",");
  const body = rows.map((row) =>
    STRATEGY_COMPARISON_EXPORT_FIELDS.map((field) =>
      escapeCsvCell(row[field]),
    ).join(","),
  );
  return [header, ...body].join("\n");
}

export function downloadStrategyComparisonExport(
  strategies: StrategyYield[],
  format: StrategyComparisonExportFormat,
): void {
  const generatedAt = new Date();
  const contents = serializeStrategyComparisonExport(
    strategies,
    format,
    generatedAt,
  );
  const mimeType =
    format === "json" ? "application/json" : "text/csv;charset=utf-8";
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = createStrategyComparisonExportFilename(format, generatedAt);
  link.click();
  URL.revokeObjectURL(url);
}
