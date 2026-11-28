// import removed: getYieldData unused

import {
  analyzeConcentration,
  type ConcentrationAnalysis,
  type ConcentrationThresholdsInput,
  type ConcentrationWarning,
} from "../../../shared/types/exposureConcentration";
import {
  computePortfolioValuationSummary,
  type PortfolioValuationSummary,
  type ValuationPriceStatus,
} from "../../../shared/types/portfolioValuation";
import {
  assertValuationConfigCurrent,
  captureValuationConfig,
  computeValuationConfigFingerprint,
  type PortfolioValuationConfig,
  type ValuationConfigFingerprint,
  type ValuationConfigSnapshot,
} from "../../../shared/types/portfolioValuationConfig";
import {
  getConcentrationThresholds,
  readConcentrationThresholdOverrides,
} from "../config/concentrationThresholds";
import {
  computeFreshnessStatus,
  type FreshnessResult,
} from "./sourceHealthService";
import { ExportFailureError } from "../types/exportFailure";

export interface VaultPosition {
  protocol: string;
  asset: string;
  depositedUsd: number;
  /** Current valuation in USD, or null if price is unavailable (#1660). */
  currentValueUsd: number | null;
  /** ISO-8601 timestamp of when this position's source data was last fetched (#1107). */
  fetchedAt?: string | null;
  /** Explicit valuation price status (#1660). */
  priceStatus?: ValuationPriceStatus;
  isPriceUnavailable?: boolean;
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

/** Valuation summary tagged with the configuration fingerprint that produced it (#1862). */
export interface FingerprintedPortfolioValuationSummary extends PortfolioValuationSummary {
  configFingerprint: ValuationConfigFingerprint;
}

export interface ComputeValuationSummaryOptions {
  /**
   * Configuration (or a previously captured snapshot) to value against.
   * Defaults to the live deployment configuration from `getValuationConfig()`.
   */
  config?: PortfolioValuationConfig | ValuationConfigSnapshot;
  /**
   * Fingerprint the caller started its work with. When it no longer matches the
   * configuration, a retryable `VALUATION_CONFIG_STALE` error is thrown before
   * anything is computed.
   */
  expectedConfigFingerprint?: ValuationConfigFingerprint;
}

function isConfigSnapshot(
  value: PortfolioValuationConfig | ValuationConfigSnapshot,
): value is ValuationConfigSnapshot {
  return (
    typeof (value as ValuationConfigSnapshot).fingerprint === "string" &&
    typeof (value as ValuationConfigSnapshot).config === "object" &&
    (value as ValuationConfigSnapshot).config !== null
  );
}

const STRATEGY_BY_PROTOCOL: Readonly<Record<string, string>> = Object.freeze({
  Blend: "Lending",
  Soroswap: "Liquidity Provision",
  DeFindex: "Yield Aggregation",
});

export class PortfolioService {
  public static readonly SUPPORTED_ASSET_CLASSES = ["stablecoin", "crypto"];

  /** Bumped whenever valuation semantics change in a way callers must not mix. */
  public static readonly VALUATION_CONFIG_VERSION = 1;

  /**
   * The configuration that determines how portfolios are valued and graded on
   * this deployment (#1862). Its fingerprint identifies valuation results so
   * stale ones can be rejected or refreshed.
   */
  public static getValuationConfig(
    env: NodeJS.ProcessEnv = process.env,
  ): PortfolioValuationConfig {
    const thresholds = getConcentrationThresholds(env);
    return {
      version: this.VALUATION_CONFIG_VERSION,
      supportedAssetClasses: [...this.SUPPORTED_ASSET_CLASSES],
      strategyByProtocol: { ...STRATEGY_BY_PROTOCOL },
      concentrationThresholds: {
        asset: { ...thresholds.asset },
        protocol: { ...thresholds.protocol },
      },
    };
  }

  /** Fingerprint of the live valuation configuration (#1862). */
  public static getValuationConfigFingerprint(
    env: NodeJS.ProcessEnv = process.env,
  ): ValuationConfigFingerprint {
    return computeValuationConfigFingerprint(this.getValuationConfig(env));
  }

  /**
   * True when a previously computed summary was produced under the live
   * configuration and may be reused; false means it must be recomputed (#1862).
   */
  public static isValuationSummaryCurrent(
    summary: Pick<FingerprintedPortfolioValuationSummary, "configFingerprint">,
    env: NodeJS.ProcessEnv = process.env,
  ): boolean {
    return summary.configFingerprint === this.getValuationConfigFingerprint(env);
  }

  /**
   * Aggregates positions by asset, protocol, and strategy, then grades the
   * asset and protocol buckets for concentration risk. Excludes unpriced holdings.
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
      if (
        pos.currentValueUsd === null ||
        pos.currentValueUsd === undefined ||
        pos.isPriceUnavailable === true ||
        pos.priceStatus === "unpriced"
      ) {
        continue;
      }

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
      throw new ExportFailureError(
        "EXPORT_VALIDATION_FAILED",
        "Export filters cannot be empty. Please select at least one asset class.",
        { field: "assetClass" },
      );
    }

    for (const c of classes) {
      if (!this.SUPPORTED_ASSET_CLASSES.includes(c)) {
        throw new ExportFailureError(
          "EXPORT_VALIDATION_FAILED",
          `Unsupported asset class: "${c}". Supported classes are: ${this.SUPPORTED_ASSET_CLASSES.join(", ")}.`,
          { assetClass: c, supported: this.SUPPORTED_ASSET_CLASSES },
        );
      }
    }

    const filtered = positions.filter((pos) => classes.includes(this.getAssetClass(pos.asset)));

    if (filtered.length === 0) {
      throw new ExportFailureError(
        "EXPORT_NO_DATA",
        "No portfolio data matches the selected filters.",
        { requestedAssetClasses: classes },
      );
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
    const rows = holdings.map((holding) => {
      const isUnpriced =
        holding.currentValueUsd === null ||
        holding.currentValueUsd === undefined ||
        holding.isPriceUnavailable === true ||
        holding.priceStatus === "unpriced";

      const formattedCurrentValue = isUnpriced
        ? "UNAVAILABLE"
        : holding.currentValueUsd.toFixed(2);

      return [
        holding.protocol,
        holding.asset,
        holding.depositedUsd.toFixed(2),
        formattedCurrentValue,
        holding.freshness.status,
        holding.freshness.fetchedAt ?? "unknown",
      ]
        .map(escapeCsvField)
        .join(",");
    });
    return [headers.join(","), ...rows].join("\n");
  }

  /**
   * Computes valuation completeness, unpriced holdings count, and fair yield metrics (#1660),
   * tagged with the fingerprint of the configuration it was computed under (#1862).
   *
   * Pure: inputs are never mutated. When `expectedConfigFingerprint` is supplied and
   * no longer matches, a `ValuationConfigError` (`VALUATION_CONFIG_STALE`,
   * retryable) is thrown before any work is done, so callers keep their prior state.
   */
  public static computeValuationSummary(
    positions: VaultPosition[],
    options: ComputeValuationSummaryOptions = {},
  ): FingerprintedPortfolioValuationSummary {
    // Always re-derive the fingerprint from the configuration itself so a
    // tampered or hand-built snapshot cannot vouch for a different config.
    const source = options.config ?? this.getValuationConfig();
    const snapshot = captureValuationConfig(
      isConfigSnapshot(source) ? source.config : source,
    );

    if (options.expectedConfigFingerprint !== undefined) {
      assertValuationConfigCurrent(options.expectedConfigFingerprint, snapshot);
    }

    const summary = computePortfolioValuationSummary(
      positions.map((p) => ({
        protocol: p.protocol,
        asset: p.asset,
        deposited: p.depositedUsd,
        currentValue: p.currentValueUsd,
        fetchedAt: p.fetchedAt,
        isPriceUnavailable: p.isPriceUnavailable,
        priceStatus: p.priceStatus,
      })),
    );

    return { ...summary, configFingerprint: snapshot.fingerprint };
  }

  private static getStrategyForProtocol(protocol: string): string {
    return STRATEGY_BY_PROTOCOL[protocol] || "Other";
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
export type { PortfolioValuationConfig, ValuationConfigFingerprint, ValuationConfigSnapshot };
