/**
 * Treasury Scenario Preset Library (#416)
 *
 * Defines four canonical treasury allocation presets. Each preset specifies
 * a named allocation strategy across Stellar DeFi vaults.
 */

export interface PresetAllocation {
  vaultId: string;
  vaultName: string;
  allocationPct: number;
}

export interface TreasuryPreset {
  id: string;
  name: string;
  description: string;
  allocations: PresetAllocation[];
}

export const TREASURY_PRESETS: TreasuryPreset[] = [
  {
    id: "conservative",
    name: "Conservative",
    description:
      "Low-risk allocation focused on stable, audited protocols with deep liquidity. "
      + "Prioritizes capital preservation over yield maximization.",
    allocations: [
      { vaultId: "blend", vaultName: "Blend Stable", allocationPct: 60 },
      { vaultId: "defindex", vaultName: "DeFindex Index", allocationPct: 30 },
      { vaultId: "soroswap", vaultName: "Soroswap LP", allocationPct: 10 },
    ],
  },
  {
    id: "balanced",
    name: "Balanced",
    description:
      "Moderate-risk allocation balancing yield and stability across multiple protocols. "
      + "Suitable for treasuries seeking sustainable mid-range returns.",
    allocations: [
      { vaultId: "blend", vaultName: "Blend Stable", allocationPct: 40 },
      { vaultId: "defindex", vaultName: "DeFindex Index", allocationPct: 35 },
      { vaultId: "soroswap", vaultName: "Soroswap LP", allocationPct: 25 },
    ],
  },
  {
    id: "aggressive",
    name: "Aggressive",
    description:
      "High-yield allocation concentrated in higher-APY protocols with elevated risk tolerance. "
      + "Maximizes returns at the cost of higher volatility and drawdown risk.",
    allocations: [
      { vaultId: "soroswap", vaultName: "Soroswap LP", allocationPct: 55 },
      { vaultId: "defindex", vaultName: "DeFindex Index", allocationPct: 30 },
      { vaultId: "blend", vaultName: "Blend Stable", allocationPct: 15 },
    ],
  },
  {
    id: "liquidity-defense",
    name: "Liquidity Defense",
    description:
      "Liquidity-focused allocation that prioritizes deep TVL and fast exit paths. "
      + "Designed for treasuries that may need rapid capital redeployment.",
    allocations: [
      { vaultId: "blend", vaultName: "Blend Stable", allocationPct: 50 },
      { vaultId: "soroswap", vaultName: "Soroswap LP", allocationPct: 30 },
      { vaultId: "defindex", vaultName: "DeFindex Index", allocationPct: 20 },
    ],
  },
];
