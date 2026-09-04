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
  /** Structured grading behind those messages. */
  concentration: ConcentrationAnalysis;
}

export class PortfolioService {
  public static readonly SUPPORTED_ASSET_CLASSES = ["stablecoin", "crypto"];

  /**
   * Aggregates positions by asset, protocol, and strategy, then grades the
   * asset and protocol buckets for concentration risk.
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
      byAsset[pos.asset] = (byAsset[pos.asset] || 0) + pos.currentValueUsd;
      byProtocol[pos.protocol] = (byProtocol[pos.protocol] || 0) + pos.currentValueUsd;

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

  public static gradeConcentration(
    exposure: Pick<ExposureMap, "byAsset" | "byProtocol" | "totalValueUsd">,
    thresholds?: ConcentrationThresholdsInput,
  ): ConcentrationAnalysis {
    return analyzeConcentration(exposure, thresholds ?? readConcentrationThresholdOverrides());
  }

  public static getAssetClass(asset: string): string {
    const normalized = asset.toUpperCase();
    if (normalized === "USDC") {
      return "stablecoin";
    }
    return "crypto";
  }

  public static filterPositionsByAssetClass(
    positions: VaultPosition[],
    filters: Record<string, any>,
  ): VaultPosition[] {
    const assetClassParam = filters.assetClass ?? filters.assetClasses;

    let classes: string[] = [];
    if (typeof assetClassParam === "string") {
      classes = assetClassParam.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
    } else if (Array.isArray(assetClassParam)) {
      classes = assetClassParam.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
    }

    if (classes.length === 0) {
      throw new Error("Export filters cannot be empty. Please select at least one asset class.");
    }

    for (const c of classes) {
      if (!this.SUPPORTED_ASSET_CLASSES.includes(c)) {
        throw new Error(
          `Unsupported asset class: "${c}". Supported classes are: ${this.SUPPORTED_ASSET_CLASSES.join(", ")}.`,
        );
      }
    }

    const filtered = positions.filter((pos) => classes.includes(this.getAssetClass(pos.asset)));

    if (filtered.length === 0) {
      throw new Error("No portfolio data matches the selected filters.");
    }

    return filtered;
  }

  public static attachFreshness(
    positions: VaultPosition[],
    now: Date = new Date(),
  ): HoldingWithFreshness[] {
    return positions.map((position) => ({
      ...position,
      freshness: computeFreshnessStatus(position.fetchedAt, now),
    }));
  }

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

  private static getStrategyForProtocol(protocol: string): string {
    const mapping: Record<string, string> = {
      Blend: "Lending",
      Soroswap: "Liquidity Provision",
      DeFindex: "Yield Aggregation",
    };
    return mapping[protocol] || "Other";
  }
}

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export type { ConcentrationAnalysis, ConcentrationWarning };