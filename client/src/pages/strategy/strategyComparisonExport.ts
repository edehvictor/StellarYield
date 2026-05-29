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

  return strategies.map((strategy) => {
    const managementFeeBps = toExportNumber(strategy.managementFeeBps);
    const performanceFeeBps = toExportNumber(strategy.performanceFeeBps);

    return {
      generated_at: generatedAtIso,
      protocol_name: strategy.protocolName,
      apy: toExportNumber(strategy.apy),
      reward_apy: toExportNumber(strategy.rewardApy),
      total_apy: toExportNumber(strategy.totalApy),
      tvl_usd: toExportNumber(strategy.tvl),
      risk_score: toExportNumber(strategy.riskScore),
      liquidity_usd: toExportNumber(strategy.liquidityUsd),
      fee_drag_bps: managementFeeBps + performanceFeeBps,
      management_fee_bps: managementFeeBps,
      performance_fee_bps: performanceFeeBps,
      confidence_score: toExportNumber(strategy.capitalEfficiencyPct),
      rebalancing_behavior: strategy.rebalancingBehavior || "Standard",
      fetched_at: strategy.fetchedAt ?? "",
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
