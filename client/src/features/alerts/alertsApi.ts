import type { CreateAlertPayload, UserAlert } from "./types";

const BASE = "/api/alerts";

export async function fetchAlerts(walletAddress: string): Promise<UserAlert[]> {
  const res = await fetch(`${BASE}/${encodeURIComponent(walletAddress)}`);
  if (!res.ok) throw new Error("Failed to fetch alerts");
  return res.json() as Promise<UserAlert[]>;
}

export async function createAlert(payload: CreateAlertPayload): Promise<UserAlert> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Failed to create alert");
  }
  return res.json() as Promise<UserAlert>;
}

export async function deleteAlert(id: string, walletAddress: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress }),
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to delete alert");
}
