// import removed: getYieldData unused

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
  concentrationWarnings: string[];
}

export class PortfolioService {
  public static async getExposureMap(positions: VaultPosition[]): Promise<ExposureMap> {
    const exposure: ExposureMap = {
      byAsset: {},
      byProtocol: {},
      byStrategy: {},
      totalValueUsd: 0,
      concentrationWarnings: [],
    };

    if (positions.length === 0) return exposure;

    for (const pos of positions) {
      exposure.totalValueUsd += pos.currentValueUsd;

      // Aggregate by asset
      exposure.byAsset[pos.asset] = (exposure.byAsset[pos.asset] || 0) + pos.currentValueUsd;

      // Aggregate by protocol
      exposure.byProtocol[pos.protocol] = (exposure.byProtocol[pos.protocol] || 0) + pos.currentValueUsd;

      // For strategy, we might need to map protocol to strategy type
      // Simple mapping for now
      const strategy = this.getStrategyForProtocol(pos.protocol);
      exposure.byStrategy[strategy] = (exposure.byStrategy[strategy] || 0) + pos.currentValueUsd;
    }

    // Convert to percentages and check for concentration
    this.checkConcentration(exposure);

    return exposure;
  }

  private static getStrategyForProtocol(protocol: string): string {
    const mapping: Record<string, string> = {
      Blend: "Lending",
      Soroswap: "Liquidity Provision",
      DeFindex: "Yield Aggregation",
    };
    return mapping[protocol] || "Other";
  }

  private static checkConcentration(exposure: ExposureMap): void {
    const THRESHOLD = 0.5; // 50% concentration warning

    for (const [asset, value] of Object.entries(exposure.byAsset)) {
      if (value / exposure.totalValueUsd > THRESHOLD) {
        exposure.concentrationWarnings.push(`High concentration in ${asset} (${Math.round((value / exposure.totalValueUsd) * 100)}%)`);
      }
    }

    for (const [protocol, value] of Object.entries(exposure.byProtocol)) {
      if (value / exposure.totalValueUsd > THRESHOLD) {
        exposure.concentrationWarnings.push(`High concentration in ${protocol} protocol (${Math.round((value / exposure.totalValueUsd) * 100)}%)`);
      }
    }
  }
}
