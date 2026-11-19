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

function toExportNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
      !['Static', 'Dynamic', 'Yield-Weighted'].includes(s.rebalancingBehavior)) return null;
  if (typeof s.fetchedAt !== 'string') return null;
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
    const managementFeeBps = toExportNumber(validated.managementFeeBps);
    const performanceFeeBps = toExportNumber(validated.performanceFeeBps);

    return {
      generated_at: generatedAtIso,
      protocol_name: validated.protocolName,
      apy: toExportNumber(validated.apy),
      reward_apy: toExportNumber(validated.rewardApy),
      total_apy: toExportNumber(validated.totalApy),
      tvl_usd: toExportNumber(validated.tvl),
      risk_score: toExportNumber(validated.riskScore),
      liquidity_usd: toExportNumber(validated.liquidityUsd),
      fee_drag_bps: managementFeeBps + performanceFeeBps,
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
