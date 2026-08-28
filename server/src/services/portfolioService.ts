// import removed: getYieldData unused

import {
  analyzeConcentration,
  type ConcentrationAnalysis,
  type ConcentrationThresholdsInput,
  type ConcentrationWarning,
} from "../../../shared/types/exposureConcentration";
import { readConcentrationThresholdOverrides } from "../config/concentrationThresholds";

export interface VaultPosition {
  protocol: string;
  asset: string;
  depositedUsd: number;
  currentValueUsd: number;
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
}

export type { ConcentrationAnalysis, ConcentrationWarning };
