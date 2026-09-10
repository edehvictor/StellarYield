const KEY_PREFIX = "vault_slippage_";

/**
 * Loads and validates a slippage preference for a given vault.
 * Malformed or out-of-bounds preferences are ignored, returning the default.
 */
export function getVaultSlippage(vaultId: string, defaultSlippage: number): number {
  if (!vaultId) return defaultSlippage;
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${vaultId}`);
    if (!raw) return defaultSlippage;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.slippage === "number") {
      const val = parsed.slippage;
      if (Number.isFinite(val) && val >= 0.1 && val <= 15.0) {
        return val;
      }
    }
  } catch {
    // Ignore malformed storage values
  }
  return defaultSlippage;
}

/**
 * Saves a validated slippage preference for a given vault.
 */
export function setVaultSlippage(vaultId: string, slippage: number): void {
  if (!vaultId) return;
  const val = Math.min(15.0, Math.max(0.1, slippage));
  localStorage.setItem(`${KEY_PREFIX}${vaultId}`, JSON.stringify({ slippage: val }));
}

/**
 * Removes the stored slippage preference for a given vault.
 */
export function resetVaultSlippage(vaultId: string): void {
  if (!vaultId) return;
  localStorage.removeItem(`${KEY_PREFIX}${vaultId}`);
}
