import express from "express";
import request from "supertest";
import {
  initializeZapSupportedAssetsCache,
  resetZapSupportedAssetsCache,
} from "../config/zapAssetsConfig";
import zapRouter from "../routes/zap";

const ZAP_ENV_KEYS = [
  "ZAP_ASSETS_JSON",
  "XLM_SAC_CONTRACT_ID",
  "USDC_SAC_CONTRACT_ID",
  "AQUA_SAC_CONTRACT_ID",
  "VAULT_TOKEN_CONTRACT_ID",
  "VAULT_TOKEN_DECIMALS",
  "VAULT_TOKEN_SYMBOL",
  "VAULT_CONTRACT_ID",
  "CONTRACT_ID",
] as const;

function zapRoutesOnlyApp() {
  const app = express();
  app.use("/api/zap", zapRouter);
  return app;
}

describe("GET /api/zap/supported-assets", () => {
  let snapshot: Partial<Record<(typeof ZAP_ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    snapshot = {};
    for (const k of ZAP_ENV_KEYS) snapshot[k] = process.env[k];
  });

  afterEach(() => {
    resetZapSupportedAssetsCache();
    for (const k of ZAP_ENV_KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns assets, vaultToken, and vaultContractId", async () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      {
        symbol: "FOO",
        name: "Foo Coin",
        contractId: "CDFOOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        decimals: 7,
      },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "CDVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.VAULT_TOKEN_DECIMALS = "6";
    process.env.VAULT_TOKEN_SYMBOL = "USDC";
    process.env.VAULT_CONTRACT_ID = "CDYIELDAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    initializeZapSupportedAssetsCache();

    const res = await request(zapRoutesOnlyApp()).get("/api/zap/supported-assets");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      vaultContractId: "CDYIELDAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      vaultToken: {
        symbol: "USDC",
        contractId: "CDVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        decimals: 6,
      },
    });
    expect(Array.isArray(res.body.assets)).toBe(true);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0]).toMatchObject({
      symbol: "FOO",
      contractId: "CDFOOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      decimals: 7,
    });
  });

  it("returns 503 when ZAP_ASSETS_JSON is invalid", async () => {
    process.env.ZAP_ASSETS_JSON = "[";

    const res = await request(zapRoutesOnlyApp()).get("/api/zap/supported-assets");

    expect(res.status).toBe(503);
    expect(typeof res.body.error).toBe("string");
  });
});
