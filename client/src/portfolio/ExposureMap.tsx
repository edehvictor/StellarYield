import React, { useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import {
  analyzeConcentration,
  formatSharePct,
  type ConcentrationSeverity,
  type ConcentrationThresholdsInput,
  type ConcentrationWarning,
  type ExposureDimension,
} from "../../../shared/types/exposureConcentration";

interface ExposureMapProps {
  data: {
    byAsset: Record<string, number>;
    byProtocol: Record<string, number>;
    totalValue: number;
    /** Extra messages to show alongside the computed concentration warnings. */
    warnings?: string[];
  };
  /**
   * Overrides the warn/critical shares per dimension. Omitted fields fall back
   * to the shared defaults, so the client and server grade exposure the same way.
   */
  thresholds?: ConcentrationThresholdsInput;
}

const COLORS = ["#6C5DD3", "#3EAC75", "#F5A623", "#FF5E5E", "#A0AEC0"];

const SEVERITY_STYLES: Record<
  Exclude<ConcentrationSeverity, "ok">,
  { panel: string; heading: string; badge: string; label: string }
> = {
  critical: {
    panel: "border-[#FF5E5E]",
    heading: "text-[#FF5E5E]",
    badge: "bg-[#FF5E5E]/20 text-[#FF5E5E]",
    label: "Critical",
  },
  warning: {
    panel: "border-yellow-500",
    heading: "text-yellow-500",
    badge: "bg-yellow-500/20 text-yellow-500",
    label: "Warning",
  },
};

function formatUsd(value: number): string {
  return `$${value.toLocaleString()}`;
}

/** Pie slices plus the share each slice represents, for the legend labels. */
function toChartData(
  buckets: Record<string, number>,
  total: number,
): { name: string; value: number; share: number }[] {
  return Object.entries(buckets).map(([name, value]) => ({
    name,
    value,
    share: total > 0 ? value / total : 0,
  }));
}

function ExposurePie({
  title,
  dimension,
  chartData,
  warnings,
}: {
  title: string;
  dimension: ExposureDimension;
  chartData: { name: string; value: number; share: number }[];
  warnings: ConcentrationWarning[];
}) {
  const flagged = new Map(
    warnings.filter((w) => w.dimension === dimension).map((w) => [w.name, w.severity]),
  );

  return (
    <div className="glass-panel p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold">{title}</h3>
        {flagged.size > 0 && (
          <span
            className={`text-xs font-semibold px-2 py-1 rounded ${
              SEVERITY_STYLES[
                [...flagged.values()].includes("critical") ? "critical" : "warning"
              ].badge
            }`}
          >
            {flagged.size} concentrated
          </span>
        )}
      </div>
      <div style={{ width: "100%", height: 300 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={80}
              paddingAngle={5}
              dataKey="value"
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={`cell-${entry.name}`}
                  fill={COLORS[index % COLORS.length]}
                  stroke={flagged.has(entry.name) ? "#FF5E5E" : undefined}
                  strokeWidth={flagged.has(entry.name) ? 2 : undefined}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ backgroundColor: "#1A1D1F", border: "none", borderRadius: "8px" }}
              itemStyle={{ color: "#fff" }}
              formatter={(value: number) => formatUsd(value)}
            />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-4 space-y-1 text-sm">
        {chartData.map((entry) => {
          const severity = flagged.get(entry.name);
          return (
            <li key={entry.name} className="flex items-center justify-between gap-2">
              <span className="text-gray-300 truncate">{entry.name}</span>
              <span
                className={severity ? SEVERITY_STYLES[severity].heading : "text-gray-400"}
              >
                {formatSharePct(entry.share)}
                {severity ? ` · ${SEVERITY_STYLES[severity].label}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const ExposureMap: React.FC<ExposureMapProps> = ({ data, thresholds }) => {
  const { byAsset, byProtocol, totalValue } = data;
  const extraWarnings = data.warnings ?? [];

  const concentration = useMemo(
    () => analyzeConcentration({ byAsset, byProtocol, totalValueUsd: totalValue }, thresholds),
    [byAsset, byProtocol, totalValue, thresholds],
  );

  const assetData = toChartData(byAsset, concentration.totalValueUsd);
  const protocolData = toChartData(byProtocol, concentration.totalValueUsd);
  const hasWarnings = concentration.warnings.length > 0 || extraWarnings.length > 0;
  const panelSeverity = concentration.severity === "critical" ? "critical" : "warning";

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <ExposurePie
          title="Asset Exposure"
          dimension="asset"
          chartData={assetData}
          warnings={concentration.warnings}
        />
        <ExposurePie
          title="Protocol Exposure"
          dimension="protocol"
          chartData={protocolData}
          warnings={concentration.warnings}
        />
      </div>

      {hasWarnings && (
        <div
          className={`glass-panel p-6 border-l-4 ${SEVERITY_STYLES[panelSeverity].panel}`}
          role="alert"
        >
          <h3
            className={`text-lg font-bold mb-2 flex items-center gap-2 ${SEVERITY_STYLES[panelSeverity].heading}`}
          >
            ⚠️ Concentration Warnings
          </h3>
          <ul className="space-y-2 text-gray-300">
            {concentration.warnings.map((warning) => (
              <li
                key={`${warning.dimension}-${warning.name}`}
                className="flex items-start justify-between gap-3"
              >
                <span>{warning.message}</span>
                <span
                  className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded ${SEVERITY_STYLES[warning.severity].badge}`}
                >
                  {SEVERITY_STYLES[warning.severity].label}
                </span>
              </li>
            ))}
            {extraWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-gray-500">
            Thresholds: assets warn above {formatSharePct(concentration.thresholds.asset.warn)},
            protocols warn above {formatSharePct(concentration.thresholds.protocol.warn)}.
          </p>
        </div>
      )}
    </div>
  );
};
