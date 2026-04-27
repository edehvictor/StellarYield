import { RewardStream } from "../types/yields";

export interface ProtocolConfig {
  protocolName: string;
  protocolType: "blend" | "soroswap";
  baseApyBps: number;
  baseTvlUsd: number;
  volatilityPct: number;
  protocolAgeDays: number;
  protocolAgeDays: number;
  source: string;
  liquidityUsd: number;
  rebalancingBehavior: string;
  managementFeeBps: number;
  performanceFeeBps: number;
  capitalEfficiencyPct: number;
  rewardStreams?: RewardStream[];
}

export const PROTOCOLS: ProtocolConfig[] = [
  {
    protocolName: "Blend",
    protocolType: "blend",
    baseApyBps: 645,
    baseTvlUsd: 12_400_000,
    volatilityPct: 2.4,
    protocolAgeDays: 540,
    source: "stellar://blend",
    liquidityUsd: 11_200_000,
    rebalancingBehavior: "Static",
    managementFeeBps: 0,
    performanceFeeBps: 1000,
    capitalEfficiencyPct: 75,
    rewardStreams: [
      {
        tokenSymbol: "BLND",
        emissionPerYear: 1_000_000,
        tokenPrice: 0.25,
      },
    ],
  },
  {
    protocolName: "Soroswap",
    protocolType: "soroswap",
    baseApyBps: 1120,
    baseTvlUsd: 4_850_000,
    volatilityPct: 5.2,
    protocolAgeDays: 420,
    source: "stellar://soroswap",
    liquidityUsd: 3_900_000,
    rebalancingBehavior: "Dynamic",
    managementFeeBps: 30,
    performanceFeeBps: 0,
    capitalEfficiencyPct: 92,
    rewardStreams: [
      {
        tokenSymbol: "SORO",
        emissionPerYear: 500_000,
        tokenPrice: 0.15,
      },
    ],
  },
];
