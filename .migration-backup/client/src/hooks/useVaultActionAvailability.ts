import { useMemo } from "react";
import type { BackendStatus } from "./useBackendStatus";
import type { VaultStats } from "../lib/vaultData";

export type VaultAction = "deposit" | "withdraw" | "zap" | "claim" | "rebalance";

export interface VaultActionAvailability {
  available: boolean;
  reason?: string;
}

export type VaultActionAvailabilityMap = Record<VaultAction, VaultActionAvailability>;

interface VaultActionAvailabilityParams {
  walletAddress?: string | null;
  stats?: VaultStats | null;
  backendStatus: BackendStatus;
  isAtCapacity?: boolean;
}

const ACTIONS: VaultAction[] = ["deposit", "withdraw", "zap", "claim", "rebalance"];

function allUnavailable(reason: string): VaultActionAvailabilityMap {
  return ACTIONS.reduce((map, action) => {
    map[action] = { available: false, reason };
    return map;
  }, {} as VaultActionAvailabilityMap);
}

export function useVaultActionAvailability({
  walletAddress,
  stats,
  backendStatus,
  isAtCapacity = false,
}: VaultActionAvailabilityParams): VaultActionAvailabilityMap {
  return useMemo(() => {
    if (!walletAddress) {
      return allUnavailable("Connect your wallet to perform this action");
    }

    if (backendStatus === "checking") {
      return allUnavailable("Checking backend availability");
    }

    if (backendStatus === "unavailable") {
      return allUnavailable("Backend is currently unavailable");
    }

    if (!stats || !stats.live) {
      return allUnavailable("Live vault data is unavailable");
    }

    const available: VaultActionAvailability = { available: true };
    const capacityReason = "Vault is at capacity";

    return {
      deposit: isAtCapacity ? { available: false, reason: capacityReason } : available,
      withdraw: available,
      zap: isAtCapacity ? { available: false, reason: capacityReason } : available,
      claim: available,
      rebalance: available,
    };
  }, [backendStatus, isAtCapacity, stats, walletAddress]);
}
