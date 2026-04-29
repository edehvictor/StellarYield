import {
  loadZapSupportedAssetsPayload,
  validateZapAssetsJsonEntry,
} from "../config/zapAssetsConfig";

const KEYS = [
  "ZAP_ASSETS_JSON",
  "XLM_SAC_CONTRACT_ID",
  "USDC_SAC_CONTRACT_ID",
  "AQUA_SAC_CONTRACT_ID",
  "VAULT_TOKEN_CONTRACT_ID",
  "VAULT_CONTRACT_ID",
] as const;

describe("loadZapSupportedAssetsPayload", () => {
  let snapshot: Partial<Record<(typeof KEYS)[number], string | undefined>>;

  beforeEach(() => {
    snapshot = {};
    for (const k of KEYS) snapshot[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("parses ZAP_ASSETS_JSON including optional iconUrl", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      {
        symbol: "XLM",
        name: "Stellar Lumens",
        contractId: "CDXLM",
        decimals: 7,
        iconUrl: "https://example.com/xlm.png",
      },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const p = loadZapSupportedAssetsPayload(process.env);

    expect(p.assets[0]?.iconUrl).toBe("https://example.com/xlm.png");
    expect(p.vaultToken.contractId).toBe("VAULT");
    expect(p.vaultContractId).toBe("YIELD");
  });

  it("throws when ZAP_ASSETS_JSON is malformed", () => {
    process.env.ZAP_ASSETS_JSON = "not-json";
    expect(() => loadZapSupportedAssetsPayload(process.env)).toThrow(/valid JSON/);
  });

  it("throws when ZAP_ASSETS_JSON is an empty array", () => {
    process.env.ZAP_ASSETS_JSON = "[]";
    expect(() => loadZapSupportedAssetsPayload(process.env)).toThrow(
      /at least one asset/,
    );
  });

  it("falls back to SAC env vars when ZAP_ASSETS_JSON is unset", () => {
    delete process.env.ZAP_ASSETS_JSON;
    process.env.XLM_SAC_CONTRACT_ID = "CDXLM2";
    process.env.USDC_SAC_CONTRACT_ID = "";
    process.env.AQUA_SAC_CONTRACT_ID = "";

    const p = loadZapSupportedAssetsPayload(process.env);

    expect(p.assets.some((a) => a.symbol === "XLM" && a.contractId === "CDXLM2")).toBe(
      true,
    );
    expect(p.assets.every((a) => a.contractId.length > 0)).toBe(true);
  });
});

describe("validateZapAssetsJsonEntry", () => {
  it("rejects non-integer decimals", () => {
    expect(() =>
      validateZapAssetsJsonEntry({ symbol: "A", name: "A", contractId: "C", decimals: 7.1 }, 0),
    ).toThrow(/decimals/);
  });
});
