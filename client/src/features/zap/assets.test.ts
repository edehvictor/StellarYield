import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadZapAssetOptions, getVaultTokenFromEnv, getVaultContractIdFromEnv } from "./assets";

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
