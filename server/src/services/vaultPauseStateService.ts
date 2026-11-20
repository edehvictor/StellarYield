import { getContractId } from "./contractRegistry";
import { simulateReadOnlyCall } from "./sorobanReader";

export type VaultPauseStatus = "active" | "paused" | "unknown";

export interface VaultPauseState {
  status: VaultPauseStatus;
  checkedAt: string;
}

let cached: { state: VaultPauseState; expiresAt: number } | undefined;
let pending: Promise<VaultPauseState> | undefined;

/** Read on-chain pause status, briefly coalescing quote and execution checks. */
export async function getVaultPauseState(): Promise<VaultPauseState> {
  if (cached && cached.expiresAt > Date.now()) return cached.state;
  if (pending) return pending;

  pending = (async () => {
    const checkedAt = new Date().toISOString();
    const contractId = getContractId("vault");
    if (!contractId) return { status: "unknown", checkedAt };

    let status: VaultPauseStatus = "unknown";
    try {
      const result = await simulateReadOnlyCall<unknown>(contractId, "is_paused");
      if (result.ok && typeof result.value === "boolean") {
        status = result.value ? "paused" : "active";
      }
    } catch {
      status = "unknown";
    }
    const state = { status, checkedAt };
    cached = { state, expiresAt: Date.now() + 5_000 };
    return state;
  })().finally(() => {
    pending = undefined;
  });

  return pending;
}
