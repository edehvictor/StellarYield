// import removed: getYieldData unused

import {
  analyzeConcentration,
  type ConcentrationAnalysis,
  type ConcentrationThresholdsInput,
  type ConcentrationWarning,
} from "../../../shared/types/exposureConcentration";
import { readConcentrationThresholdOverrides } from "../config/concentrationThresholds";
import {
  computeFreshnessStatus,
  type FreshnessResult,
} from "./sourceHealthService";

export interface VaultPosition {
  protocol: string;
  asset: string;
  depositedUsd: number;
  currentValueUsd: number;
  /** ISO-8601 timestamp of when this position's source data was last fetched (#1107). */
  fetchedAt?: string | null;
}

/** A holding with its source-freshness metadata attached (#1107). */
export interface HoldingWithFreshness extends VaultPosition {
  freshness: FreshnessResult;
}

export interface ExposureMap {
  byAsset: Record<string, number>;
  byProtocol: Record<string, number>;
  byStrategy: Record<string, number>;
  totalValueUsd: number;
  /** Warning messages, kept as plain strings for existing consumers. */
  concentrationWarnings: string[];
  /** Structured grading (shares, severities, thresholds) behind those messages. */
  concentration: ConcentrationAnalysis;
}

export class PortfolioService {
  /**
   * Aggregates positions by asset, protocol, and strategy, then grades the
   * asset and protocol buckets for concentration risk.
   *
   * @param thresholds Optional per-request overrides. Omitted fields fall back
   * to the deployment's configured thresholds, then to the shared defaults.
   */
  public static async getExposureMap(
    positions: VaultPosition[],
    thresholds?: ConcentrationThresholdsInput,
  ): Promise<ExposureMap> {
    const byAsset: Record<string, number> = {};
    const byProtocol: Record<string, number> = {};
    const byStrategy: Record<string, number> = {};
    let totalValueUsd = 0;

    for (const pos of positions) {
      totalValueUsd += pos.currentValueUsd;

      // Aggregate by asset
      byAsset[pos.asset] = (byAsset[pos.asset] || 0) + pos.currentValueUsd;

      // Aggregate by protocol
      byProtocol[pos.protocol] = (byProtocol[pos.protocol] || 0) + pos.currentValueUsd;

      // For strategy, we might need to map protocol to strategy type
      // Simple mapping for now
      const strategy = this.getStrategyForProtocol(pos.protocol);
      byStrategy[strategy] = (byStrategy[strategy] || 0) + pos.currentValueUsd;
    }

    const concentration = analyzeConcentration(
      { byAsset, byProtocol, totalValueUsd },
      thresholds ?? readConcentrationThresholdOverrides(),
    );

    return {
      byAsset,
      byProtocol,
      byStrategy,
      totalValueUsd,
      concentrationWarnings: concentration.messages,
      concentration,
    };
  }

  /**
   * Grades an already-aggregated exposure map without rebuilding it — used when
   * thresholds change but the underlying positions have not.
   */
  public static gradeConcentration(
    exposure: Pick<ExposureMap, "byAsset" | "byProtocol" | "totalValueUsd">,
    thresholds?: ConcentrationThresholdsInput,
  ): ConcentrationAnalysis {
    return analyzeConcentration(exposure, thresholds ?? readConcentrationThresholdOverrides());
  }

  private static getStrategyForProtocol(protocol: string): string {
    const mapping: Record<string, string> = {
      Blend: "Lending",
      Soroswap: "Liquidity Provision",
      DeFindex: "Yield Aggregation",
    };
    return mapping[protocol] || "Other";
  }

  /**
   * Attaches source-freshness metadata to each holding (#1107), so
   * consumers (portfolio views, exports) can render a consistent
   * fresh/stale/unknown badge per row.
   */
  public static attachFreshness(
    positions: VaultPosition[],
    now: Date = new Date(),
  ): HoldingWithFreshness[] {
    return positions.map((position) => ({
      ...position,
      freshness: computeFreshnessStatus(position.fetchedAt, now),
    }));
  }

  /**
   * Renders holdings (with freshness already attached) as a CSV string,
   * preserving the same freshness state shown in the UI (#1107) so an
   * exported report never silently drops that context.
   */
  public static holdingsToCsv(holdings: HoldingWithFreshness[]): string {
    const headers = [
      "Protocol",
      "Asset",
      "Deposited (USD)",
      "Current Value (USD)",
      "Source Freshness",
      "Last Updated",
    ];
    const rows = holdings.map((holding) =>
      [
        holding.protocol,
        holding.asset,
        holding.depositedUsd.toFixed(2),
        holding.currentValueUsd.toFixed(2),
        holding.freshness.status,
        holding.freshness.fetchedAt ?? "unknown",
      ]
        .map(escapeCsvField)
        .join(","),
    );
    return [headers.join(","), ...rows].join("\n");
  }
  public static readonly SUPPORTED_ASSET_CLASSES = ["stablecoin", "crypto"];

  public static getAssetClass(asset: string): string {
    const normalized = asset.toUpperCase();
    if (normalized === "USDC") {
      return "stablecoin";
    }
    return "crypto";
  }

  public static filterPositionsByAssetClass(
    positions: VaultPosition[],
    filters: Record<string, any>
  ): VaultPosition[] {
    const assetClassParam = filters.assetClass ?? filters.assetClasses;

    let classes: string[] = [];
    if (typeof assetClassParam === "string") {
      classes = assetClassParam.split(",").map(c => c.trim().toLowerCase()).filter(Boolean);
    } else if (Array.isArray(assetClassParam)) {
      classes = assetClassParam.map(c => String(c).trim().toLowerCase()).filter(Boolean);
    }

    if (classes.length === 0) {
      throw new Error("Export filters cannot be empty. Please select at least one asset class.");
    }

    for (const c of classes) {
      if (!this.SUPPORTED_ASSET_CLASSES.includes(c)) {
        throw new Error(`Unsupported asset class: "${c}". Supported classes are: ${this.SUPPORTED_ASSET_CLASSES.join(", ")}.`);
      }
    }

    const filtered = positions.filter(pos => {
      const cls = this.getAssetClass(pos.asset);
      return classes.includes(cls);
    });

    if (filtered.length === 0) {
      throw new Error("No portfolio data matches the selected filters.");
    }

    return filtered;
  }
}

/** Escape a CSV field: quote and double-up inner quotes if it contains a comma, quote, or newline. */
function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export type { ConcentrationAnalysis, ConcentrationWarning };
