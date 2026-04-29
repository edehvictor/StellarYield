import type { ZapAssetOption, ZapSupportedAssetsMetadata } from "./types";
import { getApiBaseUrl } from "../../lib/api";

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

function zapApiBaseUrl(): string {
  return getApiBaseUrl();
}

/** When `VITE_ZAP_METADATA_FROM_API` is true, the Zap UI may load assets from the backend. */
export function shouldLoadZapMetadataFromApi(): boolean {
  return import.meta.env.VITE_ZAP_METADATA_FROM_API === "true";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isZapAssetOption(v: unknown): v is ZapAssetOption {
  if (!isRecord(v)) return false;
  return (
    typeof v.symbol === "string" &&
    typeof v.name === "string" &&
    typeof v.contractId === "string" &&
    typeof v.decimals === "number" &&
    Number.isFinite(v.decimals)
  );
}

/** Fetches `/api/zap/supported-assets`; returns null on network or schema errors. */
export async function fetchZapSupportedAssetsMetadata(): Promise<ZapSupportedAssetsMetadata | null> {
  try {
    const res = await fetch(`${zapApiBaseUrl()}/api/zap/supported-assets`);
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (!isRecord(json)) return null;
    if (!Array.isArray(json.assets) || typeof json.vaultContractId !== "string") {
      return null;
    }
    if (!isZapAssetOption(json.vaultToken)) return null;
    if (!json.assets.every(isZapAssetOption)) return null;
    return {
      assets: json.assets,
      vaultToken: json.vaultToken,
      vaultContractId: json.vaultContractId,
    };
  } catch {
    return null;
  }
}

export function mergeVaultIntoZapSelectableAssets(
  zapInputs: ZapAssetOption[],
  vaultToken: ZapAssetOption,
): ZapAssetOption[] {
  const merged = [...zapInputs];
  if (vaultToken.contractId && !merged.some((a) => a.contractId === vaultToken.contractId)) {
    merged.push(vaultToken);
  }
  return merged;
}

export function buildSelectableZapAssetsFromMetadata(meta: ZapSupportedAssetsMetadata): ZapAssetOption[] {
  return mergeVaultIntoZapSelectableAssets(meta.assets, meta.vaultToken);
}
