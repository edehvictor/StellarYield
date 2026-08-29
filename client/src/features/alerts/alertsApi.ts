import { apiUrl } from "../../lib/api";
import type {
  CreateAlertPayload,
  UserAlert,
  WatchlistDigestPreference,
} from "./types";

const ALERTS_BASE = apiUrl("/api/alerts");
const NOTIFICATIONS_BASE = apiUrl("/api/notifications");

export type AlertClassPreference = Record<string, boolean>;

export interface ChannelNotificationPreference {
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
  const res = await fetch(ALERTS_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
): Promise<WatchlistDigestPreference> {
  const res = await fetch(
    `${NOTIFICATIONS_BASE}/digest/preferences/${encodeURIComponent(walletAddress)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
