import { apiUrl } from "../../lib/api";
import type {
  AlertPreferences,
  CreateAlertPayload,
  UserAlert,
  WatchlistDigestPreference,
} from "./types";

const ALERTS_BASE = apiUrl("/api/alerts");
const NOTIFICATIONS_BASE = apiUrl("/api/notifications");

export type AlertClassPreference = Record<string, boolean>;

/**
 * Channel-level notification preferences.
 * `enabled` is the default state for all alert classes on this channel.
 * `alertClasses` values override `enabled` for specific alert classes.
 */
export interface ChannelNotificationPreference {
  enabled: boolean;
  alertClasses: AlertClassPreference;
}

export interface NotificationPreferences {
  channels: {
    email: ChannelNotificationPreference;
    digest: ChannelNotificationPreference;
    in_app: ChannelNotificationPreference;
  };
}

export async function fetchAlerts(walletAddress: string): Promise<UserAlert[]> {
  const res = await fetch(`${ALERTS_BASE}/${encodeURIComponent(walletAddress)}`);
  if (!res.ok) throw new Error("Failed to fetch alerts");
  return res.json() as Promise<UserAlert[]>;
}

export async function createAlert(payload: CreateAlertPayload): Promise<UserAlert> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (payload.operationIdentity) {
    headers["X-Operation-Identity"] = payload.operationIdentity;
    headers["Idempotency-Key"] = payload.operationIdentity;
  }
  const res = await fetch(ALERTS_BASE, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to create alert");
  }
  return res.json() as Promise<UserAlert>;
}

export async function deleteAlert(id: string, walletAddress: string): Promise<void> {
  const res = await fetch(`${ALERTS_BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress }),
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to delete alert");
}

export async function fetchAlertPreferences(
  walletAddress: string,
  vaultId: string,
): Promise<AlertPreferences | null> {
  const res = await fetch(
    `${ALERTS_BASE}/preferences/${encodeURIComponent(walletAddress)}/${encodeURIComponent(vaultId)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to fetch alert preferences");
  return res.json() as Promise<AlertPreferences>;
}

export async function saveAlertPreferences(
  walletAddress: string,
  vaultId: string,
  preferences: AlertPreferences,
  operationIdentity?: string,
): Promise<AlertPreferences> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (operationIdentity) {
    headers["X-Operation-Identity"] = operationIdentity;
    headers["Idempotency-Key"] = operationIdentity;
  }
  const res = await fetch(`${ALERTS_BASE}/preferences`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      walletAddress,
      vaultId,
      preferences,
      operationIdentity,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to save alert preferences");
  }
  return res.json() as Promise<AlertPreferences>;
}

export async function fetchDigestPreference(
  walletAddress: string,
): Promise<WatchlistDigestPreference> {
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/digest/preferences/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) throw new Error("Failed to fetch digest preferences");
  return res.json() as Promise<WatchlistDigestPreference>;
}

export async function saveDigestPreference(
  walletAddress: string,
  payload: WatchlistDigestPreference,
  operationIdentity?: string,
): Promise<WatchlistDigestPreference> {
  const opId = operationIdentity ?? payload.operationIdentity;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opId) {
    headers["X-Operation-Identity"] = opId;
    headers["Idempotency-Key"] = opId;
  }
  const bodyPayload = opId ? { ...payload, operationIdentity: opId } : payload;
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/digest/preferences/${encodeURIComponent(walletAddress)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(bodyPayload),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to save digest preferences");
  }
  return res.json() as Promise<WatchlistDigestPreference>;
}

export async function fetchNotificationPreferences(
  walletAddress: string,
): Promise<NotificationPreferences> {
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/preferences/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) throw new Error("Failed to fetch notification preferences");
  return res.json() as Promise<NotificationPreferences>;
}

export async function saveNotificationPreferences(
  walletAddress: string,
  payload: NotificationPreferences,
): Promise<NotificationPreferences> {
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/preferences/${encodeURIComponent(walletAddress)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Failed to save notification preferences");
  }
  return res.json() as Promise<NotificationPreferences>;
}