import { apiUrl } from "../../lib/api";
import type { AllocationPreset, PresetAllocation } from "./types";

export async function listPresets(walletAddress: string): Promise<AllocationPreset[]> {
  const res = await fetch(apiUrl(`/api/presets?wallet=${encodeURIComponent(walletAddress)}`));
  if (!res.ok) throw new Error("Failed to fetch presets");
  return res.json();
}

export async function createPreset(
  walletAddress: string,
  name: string,
  allocations: PresetAllocation[],
): Promise<AllocationPreset> {
  const res = await fetch(apiUrl("/api/presets"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress, name, allocations }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(
      body.errors?.map((e: { message: string }) => e.message).join(", ") ?? "Failed to create preset",
    );
  }
  return res.json();
}

export async function updatePreset(
  walletAddress: string,
  id: string,
  name: string,
  allocations: PresetAllocation[],
): Promise<AllocationPreset> {
  const res = await fetch(apiUrl(`/api/presets/${id}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ walletAddress, name, allocations }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(
      body.errors?.map((e: { message: string }) => e.message).join(", ") ?? "Failed to update preset",
    );
  }
  return res.json();
}

export async function deletePreset(walletAddress: string, id: string): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/presets/${id}?wallet=${encodeURIComponent(walletAddress)}`),
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) throw new Error("Failed to delete preset");
}
