export type AlertCondition = "above" | "below";

export type NotificationChannel = "email" | "digest" | "in_app";

export type OverridePrecedence = "global" | "channel" | "alert_class";

export type AlertClass = "price" | "risk" | "yield" | "system";

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

/** Explicit network/ledger binding for alert preferences (Issue #1908). */
export interface AlertPreferenceContext {
  /** Raw network passphrase; the server hashes it to its network id. */
  networkPassphrase: string;
  /** Vault deployment this record belongs to. */
  vaultId: string;
  /** Preference record layout version. */
  schemaVersion: number;
}

export interface CreateAlertPayload {
  walletAddress: string;
  vaultId: string;
  condition: AlertCondition;
  thresholdValue: number;
  email?: string;
  preferences?: AlertPreferences;
  operationIdentity?: string;
  context?: AlertPreferenceContext;
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
  overrides?: Partial<Record<AlertClass, Partial<Record<NotificationChannel, ChannelNotificationPreferences>>>>;
  precedence?: OverridePrecedence[];
}

export interface UpdateAlertPreferencesPayload {
  walletAddress: string;
  vaultId: string;
  preferences: AlertPreferences;
  operationIdentity?: string;
  expectedVersion?: number;
  context?: AlertPreferenceContext;
}

export interface WatchlistDigestPreference {
  enabled: boolean;
  scheduleMode: "daily" | "weekly" | "event_threshold";
  eventThreshold: number;
  watchedVaultIds: string[];
  minApyDeltaPct: number;
  minRiskDelta: number;
  maxFreshnessHours: number;
  operationIdentity?: string;
}
