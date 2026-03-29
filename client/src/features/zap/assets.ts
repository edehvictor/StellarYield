import type { ZapAssetOption } from "./types";

/**
 * Default assets for zap input selection. Override via `VITE_ZAP_ASSETS_JSON`
 * (JSON array of `ZapAssetOption`).
 */
export function loadZapAssetOptions(): ZapAssetOption[] {
  const raw = import.meta.env.VITE_ZAP_ASSETS_JSON as string | undefined;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ZapAssetOption[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      /* fall through */
    }
  }

  const xlm = (import.meta.env.VITE_XLM_SAC_CONTRACT_ID as string) || "";
  const usdc = (import.meta.env.VITE_USDC_SAC_CONTRACT_ID as string) || "";
  const aqua = (import.meta.env.VITE_AQUA_SAC_CONTRACT_ID as string) || "";

  return [
    { symbol: "XLM", name: "Stellar Lumens", contractId: xlm, decimals: 7 },
    { symbol: "USDC", name: "USD Coin", contractId: usdc, decimals: 7 },
    { symbol: "AQUA", name: "Aquarius", contractId: aqua, decimals: 7 },
  ].filter((a) => a.contractId.length > 0);
}

export function getVaultTokenFromEnv(): ZapAssetOption {
  const contractId = (import.meta.env.VITE_VAULT_TOKEN_CONTRACT_ID as string) || "";
  const decimals = Number(import.meta.env.VITE_VAULT_TOKEN_DECIMALS ?? 7);
  return {
    symbol: (import.meta.env.VITE_VAULT_TOKEN_SYMBOL as string) || "USDC",
    name: "Vault asset",
    contractId,
    decimals: Number.isFinite(decimals) ? decimals : 7,
  };
}

export function getVaultContractIdFromEnv(): string {
  return (import.meta.env.VITE_VAULT_CONTRACT_ID as string) || (import.meta.env.VITE_CONTRACT_ID as string) || "";
}
