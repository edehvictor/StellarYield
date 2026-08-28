import crypto from "crypto";
import request from "supertest";
import { createApp } from "../app";

// Mock yieldService to prevent real Stellar network calls during CI
jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "default", tvl: 10_000_000 },
  ]),
  getYieldDataWithCacheStatus: jest.fn().mockResolvedValue({
    data: [{ protocolName: "default", tvl: 10_000_000 }],
    cacheStatus: "MISS",
  }),
}));

// Mock freezeService so no protocol is frozen by default
jest.mock("../services/freezeService", () => ({
  freezeService: {
    isFrozen: jest.fn().mockReturnValue(false),
  },
}));

const SAME_TOKEN = "CDSAMEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function computeRouteHash(path: { contractId: string }[]): string {
  const ids = path.map(p => p.contractId).join("->");
  return crypto.createHash("sha256").update(ids).digest("hex");
}

// OpenAPI example shapes used for structural validation
const OPENAPI_QUOTE_SUCCESS_EXAMPLE = {
  path: expect.arrayContaining([
    expect.objectContaining({ contractId: expect.any(String) }),
  ]),
  expectedAmountOutStroops: expect.any(String),
  source: expect.stringMatching(/^(router_simulation|fallback_rate)$/),
  slippageApplied: expect.any(Number),
  amountOutAfterSlippage: expect.any(String),
  quotedAt: expect.any(String),
  minAmountOutStroops: expect.any(String),
  quoteAgeMs: expect.any(Number),
  isFallback: expect.any(Boolean),
  issuedAt: expect.any(String),
  expiresAt: expect.any(String),
  routeHash: expect.any(String),
  assetConfigVersion: expect.any(String),
};

const OPENAPI_ERROR_EXAMPLE_SHAPE = {
  error: expect.any(String),
  message: expect.any(String),
};

// ── POST /api/zap/quote ───────────────────────────────────────────────

describe("POST /api/zap/quote", () => {
  it("returns a fallback quote for identical tokens matching OpenAPI success shape", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({
        inputTokenContract: SAME_TOKEN,
        vaultTokenContract: SAME_TOKEN,
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(OPENAPI_QUOTE_SUCCESS_EXAMPLE);
    expect(res.body.expectedAmountOutStroops).toBe("1000");
    expect(res.body.source).toBe("fallback_rate");
    expect(res.body.isFallback).toBe(true);
  });

  it("applies user-provided slippageTolerance", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({
        inputTokenContract: SAME_TOKEN,
        vaultTokenContract: SAME_TOKEN,
        amountInStroops: "10000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.02,
      });

    expect(res.status).toBe(200);
    // For identical tokens, model slippage is 0, so effective = max(0, 0.02) = 0.02
    expect(res.body.slippageApplied).toBe(0.02);
    expect(res.body.amountOutAfterSlippage).toBe("9800");
  });

  it("returns 400 with MISSING_FIELDS when body is incomplete", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({ inputTokenContract: "A" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(OPENAPI_ERROR_EXAMPLE_SHAPE);
    expect(res.body.error).toBe("MISSING_FIELDS");
    expect(res.body.message).toContain("inputTokenContract");
  });

  it("returns 400 with INVALID_AMOUNT for non-integer amountInStroops", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({
        inputTokenContract: SAME_TOKEN,
        vaultTokenContract: SAME_TOKEN,
        amountInStroops: "12.34",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_AMOUNT");
  });

  it("includes all metadata fields matching OpenAPI schema", async () => {
    const res = await request(createApp())
      .post("/api/zap/quote")
      .send({
        inputTokenContract: SAME_TOKEN,
        vaultTokenContract: SAME_TOKEN,
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

    expect(res.body.quotedAt).toBeDefined();
    expect(() => new Date(res.body.quotedAt)).not.toThrow();

    expect(res.body.minAmountOutStroops).toBeDefined();
    expect(res.body.isFallback).toBe(true);
    expect(typeof res.body.slippageApplied).toBe("number");
    expect(res.body.amountOutAfterSlippage).toBeDefined();
    expect(res.body.routeHash).toBeDefined();
    expect(typeof res.body.routeHash).toBe("string");
    expect(res.body.routeHash.length).toBeGreaterThan(0);
    expect(res.body.assetConfigVersion).toBeDefined();
    expect(typeof res.body.assetConfigVersion).toBe("string");
    expect(res.body.assetConfigVersion.length).toBeGreaterThan(0);
    expect(res.body.issuedAt).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
  });
});

// ── POST /api/zap/verify ───────────────────────────────────────────────

describe("POST /api/zap/verify", () => {
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
  let envSnapshot: Partial<Record<string, string | undefined>>;
  let assetConfigVersion: string;

  beforeAll(async () => {
    // Save env
    envSnapshot = {};
    for (const k of ZAP_ENV_KEYS) envSnapshot[k] = process.env[k];

    // Configure a known supported asset so we can test verification end-to-end
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      {
        symbol: "SAME",
        name: "Same Token",
        contractId: SAME_TOKEN,
        decimals: 7,
      },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = SAME_TOKEN;
    process.env.VAULT_CONTRACT_ID = "CDYIELDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

    // Reset cache and get fresh config version
    const { resetZapSupportedAssetsCache, initializeZapSupportedAssetsCache } =
      await import("../config/zapAssetsConfig");
    resetZapSupportedAssetsCache();
    initializeZapSupportedAssetsCache();

    const { getAssetConfigVersion } = await import("../services/zapQuote");
    assetConfigVersion = getAssetConfigVersion();
  });

  afterAll(() => {
    // Restore env
    for (const k of ZAP_ENV_KEYS) {
      const v = envSnapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function validQuote(overrides: Record<string, unknown> = {}) {
    const hasPathOverride = "path" in overrides;
    const path = hasPathOverride
      ? (overrides.path as { contractId: string }[])
      : [{ contractId: SAME_TOKEN }];
    const base = {
      path,
      expectedAmountOutStroops: "1000",
      source: "fallback_rate",
      slippageApplied: 0.005,
      amountOutAfterSlippage: "995",
      quotedAt: new Date().toISOString(),
      minAmountOutStroops: "995",
      quoteAgeMs: 0,
      isFallback: true,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      routeHash: computeRouteHash(path),
      assetConfigVersion,
    };
    return { ...base, ...overrides };
  }

  it("returns success:true for a valid quote", async () => {
    const res = await request(createApp())
      .post("/api/zap/verify")
      .send(validQuote());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("returns 400 with STALE_QUOTE when quote has expired", async () => {
    const res = await request(createApp())
      .post("/api/zap/verify")
      .send(validQuote({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(OPENAPI_ERROR_EXAMPLE_SHAPE);
    expect(res.body.error).toBe("STALE_QUOTE");
    expect(res.body.message).toMatch(/expired/i);
  });

  it("returns 400 with UNSUPPORTED_ASSET when path contains an unknown contract", async () => {
    const res = await request(createApp())
      .post("/api/zap/verify")
      .send(validQuote({
        path: [{ contractId: "CDUNKNOWNXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" }],
      }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(OPENAPI_ERROR_EXAMPLE_SHAPE);
    expect(res.body.error).toBe("UNSUPPORTED_ASSET");
    expect(res.body.message).toMatch(/no longer supported/i);
  });

  it("returns 400 with SLIPPAGE_EXCEEDED when slippageApplied > 15%", async () => {
    const res = await request(createApp())
      .post("/api/zap/verify")
      .send(validQuote({ slippageApplied: 0.185 }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(OPENAPI_ERROR_EXAMPLE_SHAPE);
    expect(res.body.error).toBe("SLIPPAGE_EXCEEDED");
    expect(res.body.message).toMatch(/slippage/i);
  });

  it("rejects a non-object body with 400", async () => {
    // Ensure an invalid (non-object) JSON body returns 400 even if the
    // specific error code varies depending on how the body is parsed.
    const res = await request(createApp())
      .post("/api/zap/verify")
      .send("");

    expect(res.status).toBe(400);
  });

  it("returns 400 with ROUTE_MISMATCH when routeHash does not match path", async () => {
    const res = await request(createApp())
      .post("/api/zap/verify")
      .send(validQuote({ routeHash: "this-hash-will-not-match" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ROUTE_MISMATCH");
  });
});

// ── GET /api/zap/supported-assets ──────────────────────────────────────

describe("GET /api/zap/supported-assets", () => {
  it("returns assets, vaultToken, and vaultContractId when configured", async () => {
    // Save original env
    const origJson = process.env.ZAP_ASSETS_JSON;
    const origVaultToken = process.env.VAULT_TOKEN_CONTRACT_ID;
    const origVault = process.env.VAULT_CONTRACT_ID;

    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      {
        symbol: "XLM",
        name: "Stellar Lumens",
        contractId: "CDXLMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        decimals: 7,
      },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "CDVAULTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    process.env.VAULT_CONTRACT_ID = "CDYIELDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

    // Clear cache so it picks up new env
    const { resetZapSupportedAssetsCache } = await import("../config/zapAssetsConfig");
    resetZapSupportedAssetsCache();

    const res = await request(createApp()).get("/api/zap/supported-assets");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      vaultContractId: "CDYIELDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      vaultToken: {
        symbol: expect.any(String),
        contractId: "CDVAULTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        decimals: expect.any(Number),
      },
      assets: expect.arrayContaining([
        expect.objectContaining({
          symbol: "XLM",
          contractId: "CDXLMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          decimals: 7,
        }),
      ]),
    });

    // Restore env
    if (origJson === undefined) delete process.env.ZAP_ASSETS_JSON;
    else process.env.ZAP_ASSETS_JSON = origJson;
    if (origVaultToken === undefined) delete process.env.VAULT_TOKEN_CONTRACT_ID;
    else process.env.VAULT_TOKEN_CONTRACT_ID = origVaultToken;
    if (origVault === undefined) delete process.env.VAULT_CONTRACT_ID;
    else process.env.VAULT_CONTRACT_ID = origVault;
    resetZapSupportedAssetsCache();
  });

  it("returns 503 CONFIG_UNAVAILABLE when ZAP_ASSETS_JSON is invalid JSON", async () => {
    const origJson = process.env.ZAP_ASSETS_JSON;
    process.env.ZAP_ASSETS_JSON = "[";

    const { resetZapSupportedAssetsCache } = await import("../config/zapAssetsConfig");
    resetZapSupportedAssetsCache();

    const res = await request(createApp()).get("/api/zap/supported-assets");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject(OPENAPI_ERROR_EXAMPLE_SHAPE);
    expect(res.body.error).toBe("CONFIG_UNAVAILABLE");

    if (origJson === undefined) delete process.env.ZAP_ASSETS_JSON;
    else process.env.ZAP_ASSETS_JSON = origJson;
    resetZapSupportedAssetsCache();
  });
});
