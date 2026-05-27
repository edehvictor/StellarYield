import {
  getRecommendationTimeline,
  type RecommendationTimelineEntry,
} from "./recommendationTimelineService";

export type AccountActivityEventType =
  | "deposit"
  | "withdrawal"
  | "reward"
  | "recommendation"
  | "alert"
  | "rebalance";

export interface AccountActivityEvent {
  id: string;
  walletAddress: string;
  type: AccountActivityEventType;
  title: string;
  description: string;
  timestamp: string;
  source: "portfolio" | "rewards" | "advisor" | "monitoring" | "automation";
  amountUsd?: number;
  assetSymbol?: string;
  severity?: "info" | "warning" | "critical";
  relatedVaultId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

interface TransactionSeed {
  id: string;
  type: "deposit" | "withdrawal";
  amountUsd: number;
  assetSymbol: string;
  protocol: string;
  timestamp: string;
}

interface RewardSeed {
  id: string;
  amountUsd: number;
  assetSymbol: string;
  protocol: string;
  timestamp: string;
}

interface AlertSeed {
  id: string;
  vaultId: string;
  condition: string;
  severity: "warning" | "critical";
  timestamp: string;
}

interface RebalanceSeed {
  id: string;
  vaultId: string;
  fromProtocol: string;
  toProtocol: string;
  expectedApyDeltaPct: number;
  timestamp: string;
}

const TRANSACTION_SEEDS: TransactionSeed[] = [
  {
    id: "tx-1",
    type: "deposit",
    amountUsd: 5_000,
    assetSymbol: "USDC",
    protocol: "Blend Stable",
    timestamp: "2026-05-26T08:15:00.000Z",
  },
  {
    id: "tx-2",
    type: "withdrawal",
    amountUsd: 620,
    assetSymbol: "USDC",
    protocol: "Blend Stable",
    timestamp: "2026-05-25T14:22:00.000Z",
  },
  {
    id: "tx-3",
    type: "deposit",
    amountUsd: 1_850,
    assetSymbol: "XLM",
    protocol: "Soroswap Yield LP",
    timestamp: "2026-05-24T10:05:00.000Z",
  },
];

const REWARD_SEEDS: RewardSeed[] = [
  {
    id: "reward-1",
    amountUsd: 84.5,
    assetSymbol: "YIELD",
    protocol: "Yield Index",
    timestamp: "2026-05-26T06:30:00.000Z",
  },
  {
    id: "reward-2",
    amountUsd: 19.25,
    assetSymbol: "BLND",
    protocol: "Blend Stable",
    timestamp: "2026-05-24T18:45:00.000Z",
  },
];

const ALERT_SEEDS: AlertSeed[] = [
  {
    id: "alert-1",
    vaultId: "Blend Stable",
    condition: "Risk score moved above your watch threshold",
    severity: "warning",
    timestamp: "2026-05-26T09:40:00.000Z",
  },
  {
    id: "alert-2",
    vaultId: "Yield Index",
    condition: "Freshness lag exceeded 12 hours",
    severity: "critical",
    timestamp: "2026-05-23T11:00:00.000Z",
  },
];

const REBALANCE_SEEDS: RebalanceSeed[] = [
  {
    id: "rebalance-1",
    vaultId: "Yield Index",
    fromProtocol: "Blend Stable",
    toProtocol: "Soroswap Yield LP",
    expectedApyDeltaPct: 1.4,
    timestamp: "2026-05-25T07:10:00.000Z",
  },
];

function mapRecommendationEvent(
  walletAddress: string,
  entry: RecommendationTimelineEntry,
): AccountActivityEvent {
  return {
    id: `recommendation-${entry.id}`,
    walletAddress,
    type: "recommendation",
    title: `Advisor moved allocation toward ${entry.targetVault}`,
    description: entry.rationale,
    timestamp: entry.timestamp,
    source: "advisor",
    severity: entry.reasonCodes.some((code) => code.severity === "critical")
      ? "critical"
      : entry.reasonCodes.some((code) => code.severity === "warning")
        ? "warning"
        : "info",
    relatedVaultId: entry.targetVault,
    metadata: {
      changedInputs: entry.changedInputs.join(", "),
    },
  };
}

function buildSeededEvents(walletAddress: string): AccountActivityEvent[] {
  const transactions = TRANSACTION_SEEDS.map<AccountActivityEvent>((seed) => ({
    id: seed.id,
    walletAddress,
    type: seed.type,
    title:
      seed.type === "deposit"
        ? `Deposited ${seed.assetSymbol} into ${seed.protocol}`
        : `Withdrew ${seed.assetSymbol} from ${seed.protocol}`,
    description:
      seed.type === "deposit"
        ? `Capital routed into ${seed.protocol} for yield capture.`
        : `Capital withdrawn after rebalancing or user exit.`,
    timestamp: seed.timestamp,
    source: "portfolio",
    amountUsd: seed.amountUsd,
    assetSymbol: seed.assetSymbol,
    severity: "info",
    relatedVaultId: seed.protocol,
  }));

  const rewards = REWARD_SEEDS.map<AccountActivityEvent>((seed) => ({
    id: seed.id,
    walletAddress,
    type: "reward",
    title: `Reward accrued from ${seed.protocol}`,
    description: `Claimable ${seed.assetSymbol} rewards were refreshed for this position.`,
    timestamp: seed.timestamp,
    source: "rewards",
    amountUsd: seed.amountUsd,
    assetSymbol: seed.assetSymbol,
    severity: "info",
    relatedVaultId: seed.protocol,
  }));

  const alerts = ALERT_SEEDS.map<AccountActivityEvent>((seed) => ({
    id: seed.id,
    walletAddress,
    type: "alert",
    title: `Watch alert for ${seed.vaultId}`,
    description: seed.condition,
    timestamp: seed.timestamp,
    source: "monitoring",
    severity: seed.severity,
    relatedVaultId: seed.vaultId,
  }));

  const rebalances = REBALANCE_SEEDS.map<AccountActivityEvent>((seed) => ({
    id: seed.id,
    walletAddress,
    type: "rebalance",
    title: `Rebalanced ${seed.vaultId}`,
    description: `Moved exposure from ${seed.fromProtocol} to ${seed.toProtocol} for an estimated ${seed.expectedApyDeltaPct.toFixed(1)}% APY lift.`,
    timestamp: seed.timestamp,
    source: "automation",
    severity: "info",
    relatedVaultId: seed.vaultId,
    metadata: {
      expectedApyDeltaPct: seed.expectedApyDeltaPct,
      fromProtocol: seed.fromProtocol,
      toProtocol: seed.toProtocol,
    },
  }));

  return [...transactions, ...rewards, ...alerts, ...rebalances];
}

export function buildUnifiedAccountTimeline(
  walletAddress: string,
  filters?: AccountActivityEventType[],
): AccountActivityEvent[] {
  const seededEvents = buildSeededEvents(walletAddress);
  const recommendationEvents = getRecommendationTimeline(walletAddress).map((entry) =>
    mapRecommendationEvent(walletAddress, entry),
  );

  const allEvents = [...seededEvents, ...recommendationEvents].sort(
    (left, right) =>
      new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
  );

  if (!filters || filters.length === 0) {
    return allEvents;
  }

  const allowed = new Set(filters);
  return allEvents.filter((event) => allowed.has(event.type));
}

