export type WatchlistTargetType = "protocol" | "pool" | "strategy";

export interface WatchlistCondition {
  metric: "apy" | "tvl" | "spread";
  operator: "above" | "below" | "change_above";
  value: number;
}

export interface WatchlistRule {
  id: string;
  userId: string;
  targetType: WatchlistTargetType;
  targetId: string;
  targetName: string;
  conditions: WatchlistCondition[];
  notificationChannels: ("email" | "webhook" | "push")[];
  status: "active" | "paused" | "triggered";
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWatchlistRulePayload {
  targetType: WatchlistTargetType;
  targetId: string;
  targetName: string;
  conditions: WatchlistCondition[];
  notificationChannels: ("email" | "webhook" | "push")[];
}

export interface UpdateWatchlistRulePayload {
  status?: "active" | "paused" | "triggered";
  conditions?: WatchlistCondition[];
  notificationChannels?: ("email" | "webhook" | "push")[];
}