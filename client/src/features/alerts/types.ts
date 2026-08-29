export type AlertCondition = "above" | "below";

export type NotificationChannel = "email" | "digest" | "in_app";

export interface UserAlert {
  id: string;
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email: string;
  status: "active" | "triggered" | "deleted";
  triggeredAt: string | null;
  createdAt: string;
}

export interface CreateAlertPayload {
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email: string;
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
}

export interface WatchlistDigestPreference {
  enabled: boolean;
  scheduleMode: "daily" | "weekly" | "event_threshold";
  eventThreshold: number;
  watchedVaultIds: string[];
  minApyDeltaPct: number;
  minRiskDelta: number;
  maxFreshnessHours: number;
}
