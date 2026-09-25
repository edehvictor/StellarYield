/**
 * Types and interfaces for vault rebalance events.
 * Used by both the client and server for tracking and displaying rebalance activity.
 */

export interface RebalanceAllocation {
  protocol: string;
  assetSymbol: string;
  amount: number;
  percentage: number;
}

export enum RebalanceTriggerReason {
  DRIFT_THRESHOLD = "drift_threshold",
  APY_OPTIMIZATION = "apy_optimization",
  RISK_MITIGATION = "risk_mitigation",
  LIQUIDITY_ADJUSTMENT = "liquidity_adjustment",
  MANUAL_TRIGGER = "manual_trigger",
  SCHEDULED_REBALANCE = "scheduled_rebalance",
}

export interface RebalanceEvent {
  id: string;
  vaultId: string;
  vaultName: string;
  timestamp: Date;
  
  // Before snapshot
  beforeAllocation: RebalanceAllocation[];
  beforeTotalValue: number;
  
  // After snapshot
  afterAllocation: RebalanceAllocation[];
  afterTotalValue: number;
  
  // Event details
  triggerReason: RebalanceTriggerReason;
  triggerDetails: {
    driftPercentage?: number;
    apyImprovement?: number; // basis points
    riskScoreChange?: {
      before: number;
      after: number;
    };
  };
  
  // Expected outcome
  expectedOutcome: {
    apyChangePercent: number; // e.g., +0.5 = +50 bps
    estimatedGainUsd: number;
    riskScore: number;
  };
  
  // Execution details
  executionStatus: "completed" | "pending" | "failed";
  executionDetails?: {
    transactionHash?: string;
    gasCost?: number;
    slippagePercent?: number;
    actualGainUsd?: number;
  };
  
  // Risk notes
  riskNotes: string[];
}

export interface RebalanceFeedOptions {
  vaultId?: string;
  limit?: number;
  offset?: number;
  triggerReason?: RebalanceTriggerReason;
}

export interface RebalanceFeedResponse {
  events: RebalanceEvent[];
  total: number;
  hasMore: boolean;
}

/**
 * Helper to format rebalance events for display
 */
export function formatRebalanceEvent(event: RebalanceEvent): {
  title: string;
  description: string;
  impact: string;
} {
  return {
    title: `${event.vaultName} Rebalanced`,
    description: `Triggered by ${event.triggerReason.replace(/_/g, " ")}: ${
      event.triggerDetails.driftPercentage
        ? `${Math.abs(event.triggerDetails.driftPercentage).toFixed(1)}% drift`
        : event.triggerDetails.apyImprovement
          ? `${event.triggerDetails.apyImprovement} bps APY improvement`
          : "optimization"
    }`,
    impact: `Expected impact: ${event.expectedOutcome.apyChangePercent > 0 ? "+" : ""}${
      event.expectedOutcome.apyChangePercent.toFixed(2)
    }% APY, $${event.expectedOutcome.estimatedGainUsd.toFixed(2)} expected gain`,
  };
}

/**
 * Helper to calculate allocation changes
 */
export function calculateAllocationDelta(
  before: RebalanceAllocation[],
  after: RebalanceAllocation[],
): Record<string, number> {
  const delta: Record<string, number> = {};

  const afterMap = new Map(after.map((a) => [a.protocol, a.percentage]));

  before.forEach((allocation) => {
    const afterPct = afterMap.get(allocation.protocol) || 0;
    delta[allocation.protocol] = afterPct - allocation.percentage;
  });

  // Add any new allocations
  afterMap.forEach((pct, protocol) => {
    if (!(protocol in delta)) {
      delta[protocol] = pct;
    }
  });

  return delta;
}
