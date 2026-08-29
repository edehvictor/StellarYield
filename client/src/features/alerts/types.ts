export type AlertCondition = "above" | "below";

export type NotificationChannel = "email" | "digest" | "in_app";

export type OverridePrecedence = "global" | "channel" | "alert_class";

export interface UserAlert {
  id: string;
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email: string | null;
  status: "active" | "triggered" | "deleted";
  triggeredAt: string | null;
  createdAt: string;
}

export interface CreateAlertPayload {
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email?: string;
  preferences?: AlertPreferences;
}

export interface ChannelNotificationPreferences {
  enabled?: boolean;
  cooldownMinutes?: number;
  severityThreshold?: number;
  quietHoursStart?: number;
  quietHoursEnd?: number;
}

export interface AlertPreferences {
  channel: NotificationChannel;
  cooldownMinutes: number;
  severityThreshold: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  overrides?: Partial<Record<NotificationChannel, ChannelNotificationPreferences>>;
  precedence?: OverridePrecedence;
}

export interface WatchlistDigestPreference {
  enabled: boolean;
  scheduleMode: "daily" | "weekly" | "event_threshold";
  eventThreshold: number;
  watchedVaultIds: string[];
  minApyDeltaPCt: number;
  minRiskDelta: number;
  maxFreshnessHours: number;
}
