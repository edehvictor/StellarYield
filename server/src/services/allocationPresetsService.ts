/**
 * Wallet-Based Allocation Presets Service
 *
 * Allows wallets to save named allocation presets for vault setup.
 * Presets do not store secrets or signed payloads — only allocation weights.
 */

export interface PresetAllocation {
  vaultId: string;
  vaultName: string;
  percentage: number;
}

export interface AllocationPreset {
  id: string;
  walletAddress: string;
  name: string;
  allocations: PresetAllocation[];
  createdAt: string;
  updatedAt: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

const SUPPORTED_VAULT_IDS = ["blend", "soroswap", "defindex"];

const store = new Map<string, AllocationPreset>();

function presetKey(walletAddress: string, id: string): string {
  return `${walletAddress}::${id}`;
}

export function validatePreset(
  walletAddress: string,
  name: string,
  allocations: PresetAllocation[],
): ValidateResult {
  const errors: ValidationError[] = [];

  if (!walletAddress || typeof walletAddress !== "string" || walletAddress.trim().length === 0) {
    errors.push({ field: "walletAddress", message: "walletAddress is required" });
  }

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required" });
  }

  if (!Array.isArray(allocations) || allocations.length === 0) {
    errors.push({ field: "allocations", message: "allocations must be a non-empty array" });
    return { ok: false, errors };
  }

  const total = allocations.reduce((sum, a) => sum + (a.percentage ?? 0), 0);
  if (Math.abs(total - 100) > 0.01) {
    errors.push({
      field: "allocations",
      message: `allocations must sum to 100% (got ${total.toFixed(2)}%)`,
    });
  }

  for (const [i, a] of allocations.entries()) {
    if (!a.vaultId || !SUPPORTED_VAULT_IDS.includes(a.vaultId)) {
      errors.push({
        field: `allocations[${i}].vaultId`,
        message: `vaultId "${a.vaultId}" is not supported. Supported: ${SUPPORTED_VAULT_IDS.join(", ")}`,
      });
    }
    if (typeof a.percentage !== "number" || a.percentage < 0 || a.percentage > 100) {
      errors.push({
        field: `allocations[${i}].percentage`,
        message: "percentage must be between 0 and 100",
      });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function createPreset(
  walletAddress: string,
  name: string,
  allocations: PresetAllocation[],
): AllocationPreset {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const preset: AllocationPreset = {
    id,
    walletAddress,
    name: name.trim(),
    allocations,
    createdAt: now,
    updatedAt: now,
  };
  store.set(presetKey(walletAddress, id), preset);
  return preset;
}

export function getPresetsForWallet(walletAddress: string): AllocationPreset[] {
  const result: AllocationPreset[] = [];
  for (const preset of store.values()) {
    if (preset.walletAddress === walletAddress) result.push(preset);
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getPreset(
  walletAddress: string,
  id: string,
): AllocationPreset | undefined {
  return store.get(presetKey(walletAddress, id));
}

export function updatePreset(
  walletAddress: string,
  id: string,
  name: string,
  allocations: PresetAllocation[],
): AllocationPreset | null {
  const existing = store.get(presetKey(walletAddress, id));
  if (!existing) return null;
  const updated: AllocationPreset = {
    ...existing,
    name: name.trim(),
    allocations,
    updatedAt: new Date().toISOString(),
  };
  store.set(presetKey(walletAddress, id), updated);
  return updated;
}

export function deletePreset(walletAddress: string, id: string): boolean {
  return store.delete(presetKey(walletAddress, id));
}
