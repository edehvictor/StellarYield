import { useMemo, type ReactNode } from "react";
import { AlertTriangle, Grid3x3 } from "lucide-react";
import {
  buildExposureHeatmap,
  ExposureHeatmapError,
  type ExposureHeatmap as ExposureHeatmapData,
  type ExposureHeatmapErrorCode,
  type ExposureHeatmapPosition,
} from "../../../../shared/types/exposureHeatmap";
import {
  formatSharePct,
  type ConcentrationSeverity,
  type ConcentrationThresholdsInput,
} from "../../../../shared/types/exposureConcentration";

interface ExposureHeatmapProps {
  positions: readonly ExposureHeatmapPosition[];
  /** Show the skeleton while positions are still loading. */
  loading?: boolean;
  thresholds?: ConcentrationThresholdsInput;
  maxAssets?: number;
  maxProtocols?: number;
}

type BuildResult =
  | { ok: true; heatmap: ExposureHeatmapData }
  | { ok: false; code: ExposureHeatmapErrorCode | "UNKNOWN" };

/** Copy keyed by error code only, so wording never depends on thrown messages. */
const ERROR_COPY: Record<ExposureHeatmapErrorCode | "UNKNOWN", string> = {
  INVALID_POSITION: "One or more positions have missing or invalid values, so exposure can't be mapped.",
  TOO_MANY_POSITIONS: "This portfolio has too many positions to map in one view.",
  INVALID_OPTIONS: "The heatmap is misconfigured.",
  UNKNOWN: "Exposure could not be mapped.",
};

const SEVERITY_RING: Record<ConcentrationSeverity, string> = {
  ok: "",
  warning: "ring-2 ring-inset ring-yellow-500",
  critical: "ring-2 ring-inset ring-[#FF5E5E]",
};

const SEVERITY_LABEL: Record<ConcentrationSeverity, string> = {
  ok: "",
  warning: "warning",
  critical: "critical",
};

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

/** Brand purple, opacity scaled to the cell's share of the largest cell. */
function cellBackground(share: number, maxShare: number): string | undefined {
  if (share <= 0 || maxShare <= 0) return undefined;
  const intensity = 0.15 + 0.75 * (share / maxShare);
  return `rgba(108, 93, 211, ${intensity.toFixed(3)})`;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <section className="glass-panel p-6" aria-labelledby="exposure-heatmap-title">
      <h3 id="exposure-heatmap-title" className="text-lg font-bold mb-1 flex items-center gap-2">
        <Grid3x3 size={18} /> Exposure Heatmap
      </h3>
      <p className="text-xs text-gray-400 mb-4">Share of portfolio value by asset and protocol.</p>
      {children}
    </section>
  );
}

export default function ExposureHeatmap({
  positions,
  loading = false,
  thresholds,
  maxAssets,
  maxProtocols,
}: ExposureHeatmapProps) {
  const result = useMemo<BuildResult>(() => {
    try {
      return {
        ok: true,
        heatmap: buildExposureHeatmap(positions, { thresholds, maxAssets, maxProtocols }),
      };
    } catch (error) {
      return { ok: false, code: error instanceof ExposureHeatmapError ? error.code : "UNKNOWN" };
    }
  }, [positions, thresholds, maxAssets, maxProtocols]);

  if (loading) {
    return (
      <Frame>
        <div
          className="h-48 w-full animate-pulse rounded-lg bg-gray-700/30"
          role="status"
          aria-label="Loading exposure heatmap"
          data-testid="exposure-heatmap-loading"
        />
      </Frame>
    );
  }

  if (!result.ok) {
    return (
      <Frame>
        <div
          className="flex items-start gap-2 rounded-lg border border-[#FF5E5E]/40 bg-[#FF5E5E]/10 p-3 text-sm text-[#FF5E5E]"
          role="alert"
          data-testid="exposure-heatmap-error"
          data-error-code={result.code}
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          {ERROR_COPY[result.code]}
        </div>
      </Frame>
    );
  }

  const { heatmap } = result;

  if (heatmap.assets.length === 0) {
    return (
      <Frame>
        <p className="text-sm text-gray-400" data-testid="exposure-heatmap-empty">
          No funded positions yet — exposure will appear here once you deposit.
        </p>
      </Frame>
    );
  }

  const flagged = heatmap.cells.flat().filter((c) => c.severity !== "ok").length;

  return (
    <Frame>
      <div className="overflow-x-auto" data-testid="exposure-heatmap" data-severity={heatmap.severity}>
        <table className="w-full border-separate border-spacing-1 text-sm">
          <caption className="sr-only">
            Portfolio exposure by asset (rows) and protocol (columns), as a share of {formatUsd(heatmap.totalValueUsd)}.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="text-left text-xs font-medium text-gray-400 px-2">
                Asset \ Protocol
              </th>
              {heatmap.protocols.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className="text-xs font-medium text-gray-300 px-2 whitespace-nowrap"
                  title={col.members.length > 1 ? col.members.join(", ") : undefined}
                >
                  {col.label}
                </th>
              ))}
              <th scope="col" className="text-xs font-medium text-gray-400 px-2">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {heatmap.assets.map((row, r) => (
              <tr key={row.key}>
                <th
                  scope="row"
                  className="text-left text-xs font-medium text-gray-300 px-2 whitespace-nowrap"
                  title={row.members.length > 1 ? row.members.join(", ") : undefined}
                >
                  {row.label}
                </th>
                {heatmap.protocols.map((col, c) => {
                  const cell = heatmap.cells[r][c];
                  const empty = cell.valueUsd === 0;
                  const severity = SEVERITY_LABEL[cell.severity];
                  return (
                    <td
                      key={col.key}
                      data-testid={`heatmap-cell-${row.key}-${col.key}`}
                      data-severity={cell.severity}
                      className={`rounded-md px-2 py-3 text-center font-mono tabular-nums ${
                        empty ? "text-gray-600 bg-gray-800/30" : "text-white"
                      } ${SEVERITY_RING[cell.severity]}`}
                      style={{ backgroundColor: cellBackground(cell.share, heatmap.maxCellShare) }}
                      title={empty ? undefined : formatUsd(cell.valueUsd)}
                      aria-label={
                        empty
                          ? `${row.label} on ${col.label}: no exposure`
                          : `${row.label} on ${col.label}: ${formatUsd(cell.valueUsd)}, ${formatSharePct(cell.share, 1)}${severity ? `, ${severity}` : ""}`
                      }
                    >
                      {empty ? "—" : formatSharePct(cell.share, 1)}
                    </td>
                  );
                })}
                <td className="px-2 text-center text-xs text-gray-400 tabular-nums">
                  {formatSharePct(row.share)}
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="text-left text-xs font-medium text-gray-400 px-2">
                Total
              </th>
              {heatmap.protocols.map((col) => (
                <td key={col.key} className="px-2 text-center text-xs text-gray-400 tabular-nums">
                  {formatSharePct(col.share)}
                </td>
              ))}
              <td className="px-2 text-center text-xs text-gray-300 tabular-nums">
                {formatUsd(heatmap.totalValueUsd)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        {flagged > 0
          ? `${flagged} pair${flagged === 1 ? "" : "s"} above the ${formatSharePct(heatmap.cellThreshold.warn)} concentration threshold (outlined).`
          : `No asset–protocol pair exceeds ${formatSharePct(heatmap.cellThreshold.warn)} of the portfolio.`}
      </p>
    </Frame>
  );
}
