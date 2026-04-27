export interface RewardStream {
  tokenSymbol: string;
  emissionPerYear: number;
  tokenPrice: number;
}

export interface ApyAttribution {
  baseYield: number;
  incentives: number;
  compounding: number;
  tacticalRotation: number;
}

export interface RawProtocolYield {
  protocolName: string;
  protocolType: "blend" | "soroswap";
  apyBps: number;
  tvlUsd: number;
  volatilityPct: number;
  protocolAgeDays: number;
  network: "mainnet" | "testnet";
  source: string;
  fetchedAt: string;
  rewards?: RewardStream[];
  attribution?: ApyAttribution;
}

export interface NormalizedYield {
  protocolName: string;
  apy: number;
  rewardApy: number;
  totalApy: number;
  tvl: number;
  riskScore: number;
  source: string;
  fetchedAt: string;
  rewards?: {
    symbol: string;
    apy: number;
  }[];
  attribution: ApyAttribution;
}
