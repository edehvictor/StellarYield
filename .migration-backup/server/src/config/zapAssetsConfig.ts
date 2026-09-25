/**
 * Zap / vault asset metadata sourced from env (mirrors client VITE_* without the prefix).
 * Validates `ZAP_ASSETS_JSON` when set; otherwise builds defaults from SAC contract env vars.
 */

export type ZapAssetPublic = {
  symbol: string;
  name: string;
  contractId: string;
  decimals: number;
  /** Optional display metadata for UIs */
  iconUrl?: string;
};

export type ZapSupportedAssetsPayload = {
  assets: ZapAssetPublic[];
  vaultToken: ZapAssetPublic;
  vaultContractId: string;
};

let cache: ZapSupportedAssetsPayload | null = null;

function asNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function asFiniteNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && Number.isInteger(v);
}

export function validateZapAssetsJsonEntry(
  raw: unknown,
  index: number,
): ZapAssetPublic {
  if (!raw || typeof raw !== "object") {
    throw new Error(`ZAP_ASSETS_JSON[${index}]: expected object`);
  }
  const o = raw as Record<string, unknown>;
  if (!asNonEmptyString(o.symbol)) {
    throw new Error(`ZAP_ASSETS_JSON[${index}].symbol must be a non-empty string`);
  }
  if (!asNonEmptyString(o.name)) {
    throw new Error(`ZAP_ASSETS_JSON[${index}].name must be a non-empty string`);
  }
  if (!asNonEmptyString(o.contractId)) {
    throw new Error(`ZAP_ASSETS_JSON[${index}].contractId must be a non-empty string`);
  }
  if (!asFiniteNonNegInt(o.decimals)) {
    throw new Error(`ZAP_ASSETS_JSON[${index}].decimals must be a non-negative integer`);
  }
  if ("iconUrl" in o && o.iconUrl !== undefined && o.iconUrl !== null) {
    if (!asNonEmptyString(o.iconUrl)) {
      throw new Error(`ZAP_ASSETS_JSON[${index}].iconUrl must be a non-empty string when set`);
    }
  }
  const iconUrl =
    o.iconUrl === undefined || o.iconUrl === null
      ? undefined
      : (o.iconUrl as string).trim();
  return {
    symbol: o.symbol.trim(),
    name: o.name.trim(),
    contractId: o.contractId.trim(),
    decimals: o.decimals,
    ...(iconUrl !== undefined ? { iconUrl } : {}),
  };
}

/**
 * Parses and validates env into a consistent payload. Used at startup and by the HTTP route.
 * @throws When `ZAP_ASSETS_JSON` is set but invalid JSON or fails schema validation.
 */
export function loadZapSupportedAssetsPayload(
  env: NodeJS.ProcessEnv = process.env,
): ZapSupportedAssetsPayload {
  const rawJson = env.ZAP_ASSETS_JSON?.trim();

  let assets: ZapAssetPublic[];

  if (rawJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson) as unknown;
    } catch (e) {
      throw new Error(
        `ZAP_ASSETS_JSON is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("ZAP_ASSETS_JSON must be a JSON array");
    }
    if (parsed.length === 0) {
      throw new Error("ZAP_ASSETS_JSON must contain at least one asset");
    }
    assets = parsed.map((item, i) => validateZapAssetsJsonEntry(item, i));
  } else {
    const xlm = env.XLM_SAC_CONTRACT_ID?.trim() ?? "";
    const usdc = env.USDC_SAC_CONTRACT_ID?.trim() ?? "";
    const aqua = env.AQUA_SAC_CONTRACT_ID?.trim() ?? "";

    assets = [
      { symbol: "XLM", name: "Stellar Lumens", contractId: xlm, decimals: 7 },
      { symbol: "USDC", name: "USD Coin", contractId: usdc, decimals: 7 },
      { symbol: "AQUA", name: "Aquarius", contractId: aqua, decimals: 7 },
    ].filter((a) => a.contractId.length > 0);
  }

  const contractId = env.VAULT_TOKEN_CONTRACT_ID?.trim() ?? "";
  const decimalsRaw = env.VAULT_TOKEN_DECIMALS ?? "7";
  const decimals = Number(decimalsRaw);
  const vaultToken: ZapAssetPublic = {
    symbol: env.VAULT_TOKEN_SYMBOL?.trim() || "USDC",
    name: "Vault asset",
    contractId,
    decimals: Number.isFinite(decimals) ? decimals : 7,
  };

  const vaultContractId =
    env.VAULT_CONTRACT_ID?.trim() || env.CONTRACT_ID?.trim() || "";

  return {
    assets,
    vaultToken,
    vaultContractId,
  };
}

/** Call from `index.ts` to validate config and prime the route cache. */
export function initializeZapSupportedAssetsCache(
  env: NodeJS.ProcessEnv = process.env,
): ZapSupportedAssetsPayload {
  resetZapSupportedAssetsCache();
  cache = loadZapSupportedAssetsPayload(env);
  return cache;
}

/**
 * Cached payload for the route handler; reset in tests via `resetZapSupportedAssetsCache`.
 */
export function getZapSupportedAssetsPayload(): ZapSupportedAssetsPayload {
  if (!cache) {
    cache = loadZapSupportedAssetsPayload();
  }
  return cache;
}

export function resetZapSupportedAssetsCache(): void {
  cache = null;
}
