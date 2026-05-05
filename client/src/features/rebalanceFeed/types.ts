export interface AllocationBreakdown {
  assetId: string;
  assetName: string;
  weight: number;
  value: number;
}

export interface AssetChange {
  assetId: string;
  assetName: string;
  beforeWeight: number;
  afterWeight: number;
  weightChange: number;
  beforeValue: number;
  afterValue: number;
  valueChange: number;
}

export interface RebalanceEvent {
  id: string;
  vaultId: string;
  vaultName: string;
  timestamp: string;
  triggerReason: string;
  expectedOutcome: string;
  riskNote: string;
  beforeAllocations: AllocationBreakdown[];
  afterAllocations: AllocationBreakdown[];
  status: "pending" | "completed" | "failed";
  changes: AssetChange[];
}