export interface VaultTargetConfig {
  vaultId: string;
  targetWeight: number; // 0.0 to 1.0 (represents percentage)
  driftThreshold: number; // 0.0 to 1.0 (e.g., 0.05 for 5%)
}

export const TARGET_ALLOCATIONS: VaultTargetConfig[] = [
  {
    vaultId: "Blend",
    targetWeight: 0.60,
    driftThreshold: 0.05, // alerts if < 55% or > 65%
  },
  {
    vaultId: "Soroswap",
    targetWeight: 0.40,
    driftThreshold: 0.05, // alerts if < 35% or > 45%
  },
];
