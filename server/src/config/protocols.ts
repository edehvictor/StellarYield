export interface ProtocolConfig {
  protocolName: string;
  protocolType: "blend" | "soroswap";
  baseApyBps: number;
  baseTvlUsd: number;
  volatilityPct: number;
  protocolAgeDays: number;
  source: string;
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
  },
  {
    protocolName: "Soroswap",
    protocolType: "soroswap",
    baseApyBps: 1120,
    baseTvlUsd: 4_850_000,
    volatilityPct: 5.2,
    protocolAgeDays: 420,
    source: "stellar://soroswap",
  },
];
