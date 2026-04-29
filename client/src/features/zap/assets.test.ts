import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadZapAssetOptions,
  getVaultTokenFromEnv,
  getVaultContractIdFromEnv,
  fetchZapSupportedAssetsMetadata,
  mergeVaultIntoZapSelectableAssets,
  shouldLoadZapMetadataFromApi,
  buildSelectableZapAssetsFromMetadata,
} from "./assets";

describe("loadZapAssetOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns parsed JSON when VITE_ZAP_ASSETS_JSON is valid", () => {
    vi.stubEnv(
      "VITE_ZAP_ASSETS_JSON",
      JSON.stringify([
        { symbol: "FOO", name: "Foo", contractId: "CDFOO", decimals: 7 },
      ]),
    );
    const list = loadZapAssetOptions();
    expect(list).toHaveLength(1);
    expect(list[0]?.symbol).toBe("FOO");
  });

  it("falls back to env contract IDs when JSON is invalid", () => {
    vi.stubEnv("VITE_ZAP_ASSETS_JSON", "not-json");
    vi.stubEnv("VITE_XLM_SAC_CONTRACT_ID", "CDXLM");
    vi.stubEnv("VITE_USDC_SAC_CONTRACT_ID", "");
    vi.stubEnv("VITE_AQUA_SAC_CONTRACT_ID", "");
    const list = loadZapAssetOptions();
    expect(list.some((a) => a.symbol === "XLM")).toBe(true);
  });

  it("falls back when JSON array is empty", () => {
    vi.stubEnv("VITE_ZAP_ASSETS_JSON", "[]");
    vi.stubEnv("VITE_XLM_SAC_CONTRACT_ID", "CDXLM2");
    vi.stubEnv("VITE_USDC_SAC_CONTRACT_ID", "");
    vi.stubEnv("VITE_AQUA_SAC_CONTRACT_ID", "");
    expect(loadZapAssetOptions().every((a) => a.contractId.length > 0)).toBe(true);
  });
});

describe("getVaultTokenFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads vault token fields from env", () => {
    vi.stubEnv("VITE_VAULT_TOKEN_CONTRACT_ID", "CDVAULT");
    vi.stubEnv("VITE_VAULT_TOKEN_DECIMALS", "6");
    vi.stubEnv("VITE_VAULT_TOKEN_SYMBOL", "USDC");
    const v = getVaultTokenFromEnv();
    expect(v.contractId).toBe("CDVAULT");
    expect(v.decimals).toBe(6);
    expect(v.symbol).toBe("USDC");
  });

  it("uses defaults when decimals are not finite", () => {
    vi.stubEnv("VITE_VAULT_TOKEN_CONTRACT_ID", "CDV");
    vi.stubEnv("VITE_VAULT_TOKEN_DECIMALS", "not-a-number");
    const v = getVaultTokenFromEnv();
    expect(v.decimals).toBe(7);
  });
});

describe("shouldLoadZapMetadataFromApi", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true only when VITE_ZAP_METADATA_FROM_API is the string true", () => {
    vi.stubEnv("VITE_ZAP_METADATA_FROM_API", "true");
    expect(shouldLoadZapMetadataFromApi()).toBe(true);
    vi.stubEnv("VITE_ZAP_METADATA_FROM_API", "false");
    expect(shouldLoadZapMetadataFromApi()).toBe(false);
  });
});

describe("fetchZapSupportedAssetsMetadata", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns parsed metadata when response is valid", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          assets: [
            { symbol: "XLM", name: "X", contractId: "CDXLM", decimals: 7 },
          ],
          vaultToken: {
            symbol: "USDC",
            name: "Vault asset",
            contractId: "CDV",
            decimals: 6,
          },
          vaultContractId: "CDY",
        }),
        { status: 200 },
      ),
    );

    const meta = await fetchZapSupportedAssetsMetadata();
    expect(meta?.vaultContractId).toBe("CDY");
    expect(meta?.assets).toHaveLength(1);
  });

  it("returns null when response is not ok", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));

    await expect(fetchZapSupportedAssetsMetadata()).resolves.toBeNull();
  });

  it("returns null when JSON shape is invalid", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ assets: "nope" }), { status: 200 }),
    );

    await expect(fetchZapSupportedAssetsMetadata()).resolves.toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(fetchZapSupportedAssetsMetadata()).resolves.toBeNull();
  });

  it("prefers VITE_API_BASE_URL and strips a trailing slash", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://example.com/");
    vi.stubEnv("VITE_API_URL", "http://ignored.example/");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          assets: [{ symbol: "XLM", name: "X", contractId: "CDX", decimals: 7 }],
          vaultToken: {
            symbol: "U",
            name: "Vault asset",
            contractId: "CDV",
            decimals: 6,
          },
          vaultContractId: "CDY",
        }),
        { status: 200 },
      ),
    );

    await fetchZapSupportedAssetsMetadata();

    expect(fetchSpy).toHaveBeenCalledWith("http://example.com/api/zap/supported-assets");
  });

  it("falls back to default localhost base when API env vars are unset", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "");
    vi.stubEnv("VITE_API_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          assets: [{ symbol: "XLM", name: "X", contractId: "CDX", decimals: 7 }],
          vaultToken: {
            symbol: "U",
            name: "Vault asset",
            contractId: "CDV",
            decimals: 6,
          },
          vaultContractId: "CDY",
        }),
        { status: 200 },
      ),
    );

    await fetchZapSupportedAssetsMetadata();

    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:3001/api/zap/supported-assets");
  });

  it("returns null when payload is not an object", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(null), { status: 200 }),
    );

    await expect(fetchZapSupportedAssetsMetadata()).resolves.toBeNull();
  });

  it("returns null when vaultToken fails validation", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          assets: [{ symbol: "XLM", name: "X", contractId: "CDX", decimals: 7 }],
          vaultToken: { symbol: "U", name: "Vault asset", contractId: "CDV", decimals: "6" },
          vaultContractId: "CDY",
        }),
        { status: 200 },
      ),
    );

    await expect(fetchZapSupportedAssetsMetadata()).resolves.toBeNull();
  });

  it("returns null when an asset row fails validation", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          assets: [{ symbol: "XLM", name: "X", contractId: "CDX", decimals: "7" }],
          vaultToken: {
            symbol: "U",
            name: "Vault asset",
            contractId: "CDV",
            decimals: 6,
          },
          vaultContractId: "CDY",
        }),
        { status: 200 },
      ),
    );

    await expect(fetchZapSupportedAssetsMetadata()).resolves.toBeNull();
  });
});

describe("mergeVaultIntoZapSelectableAssets", () => {
  it("appends vault token when missing from inputs", () => {
    const vault = {
      symbol: "USDC",
      name: "Vault asset",
      contractId: "CDV",
      decimals: 6,
    };
    const merged = mergeVaultIntoZapSelectableAssets(
      [{ symbol: "XLM", name: "X", contractId: "CDXLM", decimals: 7 }],
      vault,
    );
    expect(merged.some((a) => a.contractId === "CDV")).toBe(true);
  });

  it("does not duplicate vault token contract", () => {
    const vault = {
      symbol: "USDC",
      name: "Vault asset",
      contractId: "CDV",
      decimals: 6,
    };
    const merged = mergeVaultIntoZapSelectableAssets(
      [{ symbol: "USDC", name: "U", contractId: "CDV", decimals: 6 }],
      vault,
    );
    expect(merged.filter((a) => a.contractId === "CDV")).toHaveLength(1);
  });

  it("does not append vault when contractId is empty", () => {
    const merged = mergeVaultIntoZapSelectableAssets(
      [{ symbol: "XLM", name: "X", contractId: "CDXLM", decimals: 7 }],
      { symbol: "V", name: "Vault asset", contractId: "", decimals: 7 },
    );
    expect(merged).toHaveLength(1);
  });
});

describe("buildSelectableZapAssetsFromMetadata", () => {
  it("delegates to mergeVaultIntoZapSelectableAssets", () => {
    const meta = {
      assets: [{ symbol: "XLM", name: "X", contractId: "CDX", decimals: 7 }],
      vaultToken: {
        symbol: "USDC",
        name: "Vault asset",
        contractId: "CDV",
        decimals: 6,
      },
      vaultContractId: "CDY",
    };
    const built = buildSelectableZapAssetsFromMetadata(meta);
    const merged = mergeVaultIntoZapSelectableAssets(meta.assets, meta.vaultToken);
    expect(built).toEqual(merged);
  });
});

describe("getVaultContractIdFromEnv", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers VITE_VAULT_CONTRACT_ID", () => {
    vi.stubEnv("VITE_VAULT_CONTRACT_ID", "AAA");
    vi.stubEnv("VITE_CONTRACT_ID", "BBB");
    expect(getVaultContractIdFromEnv()).toBe("AAA");
  });

  it("falls back to VITE_CONTRACT_ID", () => {
    vi.stubEnv("VITE_CONTRACT_ID", "CCC");
    expect(getVaultContractIdFromEnv()).toBe("CCC");
  });
});
