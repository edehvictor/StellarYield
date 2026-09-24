import NodeCache from "node-cache";

// Using NodeCache for persistence during runtime, matching freezeService's
// convention. In production this would be backed by Postgres/Redis.
const cache = new NodeCache();
const REGISTRY_PREFIX = "vault-registry:";

export type VaultStatus = "ACTIVE" | "PAUSED" | "DEPRECATED";

export interface VaultRegistryEntry {
  vaultId: string;
  name: string;
  asset: string;
  protocol: string;
  strategy?: string;
  status: VaultStatus;
  capUsd?: number;
  updatedBy: string;
  updatedAt: string;
}

// Seeded from the pre-existing hardcoded VAULT_REGISTRY in
// vaultMigrationReadinessService.ts so existing vault IDs keep working.
const DEFAULT_REGISTRY: Record<string, Omit<VaultRegistryEntry, "vaultId" | "updatedBy" | "updatedAt">> = {
  usdc: { name: "USDC Yield Vault", asset: "USDC", protocol: "Blend", status: "ACTIVE" },
  xlm: { name: "XLM Yield Vault", asset: "XLM", protocol: "Blend", status: "ACTIVE" },
  "xlm-usdc": { name: "XLM-USDC LP Vault", asset: "XLM-USDC", protocol: "Soroswap", status: "ACTIVE" },
  "xlm-eth": { name: "XLM-ETH LP Vault", asset: "XLM-ETH", protocol: "Soroswap", status: "ACTIVE" },
  index: { name: "Yield Index Vault", asset: "Yield Index", protocol: "DeFindex", status: "ACTIVE" },
  bluechip: { name: "Blue Chip Vault", asset: "Blue Chip", protocol: "DeFindex", status: "ACTIVE" },
};

export class VaultRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultRegistryValidationError";
  }
}

function cacheKey(vaultId: string): string {
  return `${REGISTRY_PREFIX}${vaultId.toLowerCase()}`;
}

function getEntry(vaultId: string): VaultRegistryEntry | undefined {
  const cached = cache.get<VaultRegistryEntry>(cacheKey(vaultId));
  if (cached) return cached;

  const seed = DEFAULT_REGISTRY[vaultId.toLowerCase()];
  if (!seed) return undefined;

  return {
    vaultId,
    ...seed,
    updatedBy: "system:seed",
    updatedAt: new Date(0).toISOString(),
  };
}

export interface VaultRegistryUpdate {
  name?: string;
  strategy?: string;
  status?: VaultStatus;
  capUsd?: number;
}

const VALID_STATUSES: VaultStatus[] = ["ACTIVE", "PAUSED", "DEPRECATED"];

function validateUpdate(update: VaultRegistryUpdate): void {
  if (update.name !== undefined && update.name.trim().length === 0) {
    throw new VaultRegistryValidationError("name must not be empty");
  }
  if (update.status !== undefined && !VALID_STATUSES.includes(update.status)) {
    throw new VaultRegistryValidationError(
      `status must be one of: ${VALID_STATUSES.join(", ")}`,
    );
  }
  if (update.capUsd !== undefined && (!Number.isFinite(update.capUsd) || update.capUsd < 0)) {
    throw new VaultRegistryValidationError("capUsd must be a non-negative finite number");
  }
}

export const vaultRegistryService = {
  /** Returns every known vault's current registry entry. */
  listVaults(): VaultRegistryEntry[] {
    const seenIds = new Set(Object.keys(DEFAULT_REGISTRY));
    for (const key of cache.keys()) {
      if (key.startsWith(REGISTRY_PREFIX)) {
        seenIds.add(key.slice(REGISTRY_PREFIX.length));
      }
    }
    return Array.from(seenIds)
      .map((id) => getEntry(id))
      .filter((entry): entry is VaultRegistryEntry => entry !== undefined);
  },

  getVault(vaultId: string): VaultRegistryEntry | undefined {
    return getEntry(vaultId);
  },

  /**
   * Admin-only: applies a partial update to a vault's registry entry.
   * Unknown vaultIds are created from the update (an entry must at least
   * specify name/asset/protocol the first time via a full entry).
   */
  updateVault(
    vaultId: string,
    update: VaultRegistryUpdate,
    actor: string,
  ): VaultRegistryEntry {
    validateUpdate(update);

    const existing = getEntry(vaultId);
    if (!existing && !update.name) {
      throw new VaultRegistryValidationError(
        `Unknown vault "${vaultId}": name is required to register a new vault.`,
      );
    }

    const next: VaultRegistryEntry = {
      vaultId,
      name: update.name ?? existing!.name,
      asset: existing?.asset ?? "UNKNOWN",
      protocol: existing?.protocol ?? "UNKNOWN",
      strategy: update.strategy ?? existing?.strategy,
      status: update.status ?? existing?.status ?? "ACTIVE",
      capUsd: update.capUsd ?? existing?.capUsd,
      updatedBy: actor,
      updatedAt: new Date().toISOString(),
    };

    cache.set(cacheKey(vaultId), next);
    return next;
  },
};
