export interface PresetAllocation {
  vaultId: string;
  vaultName: string;
  percentage: number;
}

export interface AllocationPreset {
  id: string;
  walletAddress: string;
  name: string;
  allocations: PresetAllocation[];
  createdAt: string;
  updatedAt: string;
}
