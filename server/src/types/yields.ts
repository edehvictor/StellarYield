export interface RewardStream {
  tokenSymbol: string;
  emissionPerYear: number;
  tokenPrice: number;
  confidence?: "low" | "medium" | "high";
}

export interface ApyAttribution {
  baseYield: number;
  incentives: number;
  compounding: number;
  tacticalRotation: number;
}

export interface RawProtocolYield {
  protocolName: string;
  protocolType: "blend" | "soroswap" | "defindex";
  apyBps: number;
  tvlUsd: number;
  volatilityPct: number;
  protocolAgeDays: number;
  network: "mainnet" | "testnet";
  source: string;
  fetchedAt: string;
  liquidityUsd: number;
  rebalancingBehavior: string;
  managementFeeBps: number;
  performanceFeeBps: number;
  capitalEfficiencyPct: number;
  rewards?: RewardStream[];
  attribution?: ApyAttribution;
}

export interface NormalizedYield {
  protocol: string;
  asset: string;
  risk: "Low" | "Medium" | "High";
  protocolName: string;
  apy: number;
  rewardApy: number;
  totalApy: number;
  netApy: number;
  feeDragApy: number;
  tvl: number;
  riskScore: number;
  source: string;
  fetchedAt: string;
  liquidityUsd: number;
  rebalancingBehavior: string;
  managementFeeBps: number;
  performanceFeeBps: number;
  capitalEfficiencyPct: number;
  netYieldAssumptions: {
    protocolFeeBps: number;
    vaultFeeBps: number;
    rebalanceCostBps: number;
    slippageBps: number;
  };
  netYieldSensitivity: Array<{
    environment: "low" | "medium" | "high";
    assumptions: {
      protocolFeeBps: number;
      vaultFeeBps: number;
      rebalanceCostBps: number;
      slippageBps: number;
    };
    netApy: number;
    feeDragApy: number;
  }>;
  capitalEfficiency: {
    score: number;
    grade: "A" | "B" | "C" | "D";
    components: {
      utilization: number;
      feeDrag: number;
      rotationCost: number;
      liquidityDepth: number;
    };
    hasMissingInputs: boolean;
  };
  rewards?: {
    symbol: string;
    apy: number;
    confidence?: "low" | "medium" | "high";
  }[];
  attribution: ApyAttribution;
}
