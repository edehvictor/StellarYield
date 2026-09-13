/**
 * Daily portfolio movement comparison types.
 * Compares current snapshot against previous daily snapshot.
 */

export interface AssetMovement {
  asset: string;
  previousValue: number;
  currentValue: number;
  absoluteChange: number;
  percentChange: number;
  previousQuantity: number;
  currentQuantity: number;
}

export interface ProtocolMovement {
  protocol: string;
  previousValue: number;
  currentValue: number;
  absoluteChange: number;
  percentChange: number;
}

export interface DailyMovement {
  walletAddress: string;
  snapshotDate: string; // ISO date
  previousSnapshotDate?: string; // ISO date, null if no previous snapshot
  
  // Portfolio totals
  previousTotalValue: number;
  currentTotalValue: number;
  totalAbsoluteChange: number;
  totalPercentChange: number;
  
  // Breakdown by asset and protocol
  assetMovements: AssetMovement[];
  protocolMovements: ProtocolMovement[];
  
  // Adjusted movement (removes deposits/withdrawals impact)
  depositedToday: number;
  withdrawnToday: number;
  priceMovementOnly: number; // Change excluding deposits/withdrawals
  
  // State indicators
  hasPreviousSnapshot: boolean;
  isNegativeMovement: boolean;
}

/**
 * Calculate daily movement from two snapshots.
 * Returns neutral state if previous snapshot is missing.
 */
export function calculateDailyMovement(
  current: {
    walletAddress: string;
    totalValueUsd: number;
    assetBreakdown: Record<string, { valueUsd: number; quantity: number }>;
    protocolBreakdown: Record<string, { valueUsd: number }>;
  },
  previous?: {
    totalValueUsd: number;
    assetBreakdown: Record<string, { valueUsd: number; quantity: number }>;
    protocolBreakdown: Record<string, { valueUsd: number }>;
  },
  transactions?: {
    deposited: number;
    withdrawn: number;
  },
): DailyMovement {
  const now = new Date();
  const snapshotDate = now.toISOString().split('T')[0];

  if (!previous) {
    // Neutral state: no previous snapshot
    return {
      walletAddress: current.walletAddress,
      snapshotDate,
      previousSnapshotDate: undefined,
      previousTotalValue: 0,
      currentTotalValue: current.totalValueUsd,
      totalAbsoluteChange: 0,
      totalPercentChange: 0,
      assetMovements: [],
      protocolMovements: [],
      depositedToday: transactions?.deposited || 0,
      withdrawnToday: transactions?.withdrawn || 0,
      priceMovementOnly: 0,
      hasPreviousSnapshot: false,
      isNegativeMovement: false,
    };
  }

  // Calculate asset movements
  const assetMovements: AssetMovement[] = [];
  const allAssets = new Set([
    ...Object.keys(current.assetBreakdown || {}),
    ...Object.keys(previous.assetBreakdown || {}),
  ]);

  for (const asset of allAssets) {
    const prevData = previous.assetBreakdown?.[asset] || {
      valueUsd: 0,
      quantity: 0,
    };
    const currData = current.assetBreakdown?.[asset] || {
      valueUsd: 0,
      quantity: 0,
    };

    const absoluteChange = currData.valueUsd - prevData.valueUsd;
    const percentChange =
      prevData.valueUsd > 0
        ? (absoluteChange / prevData.valueUsd) * 100
        : currData.valueUsd > 0
          ? 100
          : 0;

    assetMovements.push({
      asset,
      previousValue: prevData.valueUsd,
      currentValue: currData.valueUsd,
      absoluteChange,
      percentChange,
      previousQuantity: prevData.quantity,
      currentQuantity: currData.quantity,
    });
  }

  // Calculate protocol movements
  const protocolMovements: ProtocolMovement[] = [];
  const allProtocols = new Set([
    ...Object.keys(current.protocolBreakdown || {}),
    ...Object.keys(previous.protocolBreakdown || {}),
  ]);

  for (const protocol of allProtocols) {
    const prevValue = previous.protocolBreakdown?.[protocol]?.valueUsd || 0;
    const currValue = current.protocolBreakdown?.[protocol]?.valueUsd || 0;

    const absoluteChange = currValue - prevValue;
    const percentChange =
      prevValue > 0
        ? (absoluteChange / prevValue) * 100
        : currValue > 0
          ? 100
          : 0;

    protocolMovements.push({
      protocol,
      previousValue: prevValue,
      currentValue: currValue,
      absoluteChange,
      percentChange,
    });
  }

  // Calculate total movement
  const totalAbsoluteChange = current.totalValueUsd - previous.totalValueUsd;
  const totalPercentChange =
    previous.totalValueUsd > 0
      ? (totalAbsoluteChange / previous.totalValueUsd) * 100
      : current.totalValueUsd > 0
        ? 100
        : 0;

  // Calculate price movement only (excluding deposits/withdrawals)
  const deposited = transactions?.deposited || 0;
  const withdrawn = transactions?.withdrawn || 0;
  const priceMovementOnly =
    totalAbsoluteChange - deposited + withdrawn;

  return {
    walletAddress: current.walletAddress,
    snapshotDate,
    previousSnapshotDate: previous ? now.toISOString().split('T')[0] : undefined,
    previousTotalValue: previous.totalValueUsd,
    currentTotalValue: current.totalValueUsd,
    totalAbsoluteChange,
    totalPercentChange,
    assetMovements: assetMovements.sort(
      (a, b) => Math.abs(b.absoluteChange) - Math.abs(a.absoluteChange),
    ),
    protocolMovements: protocolMovements.sort(
      (a, b) => Math.abs(b.absoluteChange) - Math.abs(a.absoluteChange),
    ),
    depositedToday: deposited,
    withdrawnToday: withdrawn,
    priceMovementOnly,
    hasPreviousSnapshot: true,
    isNegativeMovement: totalAbsoluteChange < 0,
  };
}
