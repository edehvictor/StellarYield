import {
  ZAP_QUOTE_EXPIRY_MS,
  getZapQuote,
  isQuoteExpired,
  parseQuoteExpiryMs,
  verifyZapQuote,
  RECOVERABLE_VERIFY_ERROR_CODES,
} from "../services/zapQuote";

// Mock yieldService to prevent real Stellar network calls during CI
jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "default", tvl: 10_000_000 },
  ]),
}));

// Mock freezeService so no protocol is frozen by default
jest.mock("../services/freezeService", () => ({
  freezeService: {
    isFrozen: jest.fn().mockReturnValue(false),
  },
}));

jest.mock("../config/zapAssetsConfig", () => ({
  getZapSupportedAssetsPayload: jest.fn(() => ({
    assets: [{ symbol: "XLM", name: "Lumens", contractId: "CXLM", decimals: 7 }],
    vaultToken: { symbol: "yV", name: "Vault", contractId: "CVAULT", decimals: 7 },
    vaultContractId: "CDVAULT",
  })),
}));

const SAME = {
  inputTokenContract: "CXLM",
  vaultTokenContract: "CVAULT",
  amountInStroops: "1000000",
  inputDecimals: 7,
  vaultDecimals: 7,
};

describe("parseQuoteExpiryMs", () => {
  it("parses a positive integer", () => {
    expect(parseQuoteExpiryMs("30000")).toBe(30_000);
  });

  it("falls back to 60s for missing, invalid, zero, or negative values", () => {
    expect(parseQuoteExpiryMs(undefined)).toBe(60_000);
    expect(parseQuoteExpiryMs("")).toBe(60_000);
    expect(parseQuoteExpiryMs("not-a-number")).toBe(60_000);
    expect(parseQuoteExpiryMs("0")).toBe(60_000);
    expect(parseQuoteExpiryMs("-5000")).toBe(60_000);
  });
});

describe("isQuoteExpired", () => {
  const now = 1_700_000_000_000;

  it("is false before expiresAt", () => {
    expect(
      isQuoteExpired({ expiresAt: new Date(now + 1).toISOString() }, now),
    ).toBe(false);
  });

  it("uses an exclusive boundary: valid at expiresAt, expired one ms later", () => {
    const quote = { expiresAt: new Date(now).toISOString() };
    expect(isQuoteExpired(quote, now)).toBe(false);
    expect(isQuoteExpired(quote, now + 1)).toBe(true);
  });

  it("fails closed when expiresAt is missing", () => {
    expect(isQuoteExpired({}, now)).toBe(true);
  });

  it("fails closed when expiresAt is unparseable", () => {
    expect(isQuoteExpired({ expiresAt: "not-a-timestamp" }, now)).toBe(true);
  });
});

describe("getZapQuote expiry metadata", () => {
  it("issues expiresAt exactly ZAP_QUOTE_EXPIRY_MS after quotedAt", async () => {
    const q = await getZapQuote(SAME);
    const delta =
      new Date(q.expiresAt).getTime() - new Date(q.quotedAt).getTime();
    expect(delta).toBe(ZAP_QUOTE_EXPIRY_MS);
    // A freshly issued quote must never be considered expired.
    expect(isQuoteExpired(q, new Date(q.quotedAt).getTime() + delta)).toBe(false);
    expect(isQuoteExpired(q, new Date(q.quotedAt).getTime() + delta + 1)).toBe(true);
  });

  it("honors the ZAP_QUOTE_TTL_MS environment override", async () => {
    const prev = process.env.ZAP_QUOTE_TTL_MS;
    process.env.ZAP_QUOTE_TTL_MS = "15000";
    jest.resetModules();
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require("../services/zapQuote") as typeof import("../services/zapQuote");
      expect(fresh.ZAP_QUOTE_EXPIRY_MS).toBe(15_000);

      const q = await fresh.getZapQuote(SAME);
      const quotedMs = new Date(q.quotedAt).getTime();
      expect(new Date(q.expiresAt).getTime() - quotedMs).toBe(15_000);
      expect(fresh.isQuoteExpired(q, quotedMs + 15_000)).toBe(false);
      expect(fresh.isQuoteExpired(q, quotedMs + 15_001)).toBe(true);
    } finally {
      jest.resetModules();
      if (prev === undefined) delete process.env.ZAP_QUOTE_TTL_MS;
      else process.env.ZAP_QUOTE_TTL_MS = prev;
    }
  });
});

describe("verifyZapQuote expiry invalidation", () => {
  const now = Date.now();

  function freshQuote(overrides: Record<string, unknown> = {}) {
    const path = [{ contractId: "CXLM" }];
    const routeHash = require("crypto")
      .createHash("sha256")
      .update(path.map((p) => p.contractId).join("->"))
      .digest("hex");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAssetConfigVersion } = require("../services/zapQuote") as typeof import("../services/zapQuote");
    return {
      path,
      expectedAmountOutStroops: "999000",
      source: "fallback_rate",
      slippageApplied: 0.005,
      amountOutAfterSlippage: "999000",
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: "999000",
      quoteAgeMs: 0,
      isFallback: true,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      routeHash,
      assetConfigVersion: getAssetConfigVersion(),
      ...overrides,
    };
  }

  it("accepts a fresh quote", () => {
    expect(verifyZapQuote(freshQuote())).toEqual({ valid: true });
  });

  it("rejects an expired quote with STALE_QUOTE", () => {
    const result = verifyZapQuote(
      freshQuote({ expiresAt: new Date(now - 1).toISOString() }),
    );
    expect(result).toMatchObject({ valid: false, errorCode: "STALE_QUOTE" });
  });

  it("rejects a quote with a missing expiresAt with STALE_QUOTE", () => {
    const quote = freshQuote();
    delete (quote as { expiresAt?: string }).expiresAt;
    expect(verifyZapQuote(quote)).toMatchObject({
      valid: false,
      errorCode: "STALE_QUOTE",
    });
  });

  it("rejects a quote with an unparseable expiresAt with STALE_QUOTE", () => {
    expect(
      verifyZapQuote(freshQuote({ expiresAt: "not-a-timestamp" })),
    ).toMatchObject({ valid: false, errorCode: "STALE_QUOTE" });
  });

  it("rejects non-object payloads with INVALID_QUOTE", () => {
    expect(verifyZapQuote(null)).toMatchObject({
      valid: false,
      errorCode: "INVALID_QUOTE",
    });
    expect(verifyZapQuote("junk")).toMatchObject({
      valid: false,
      errorCode: "INVALID_QUOTE",
    });
  });

  it("classifies refresh-recoverable codes and excludes input-level ones", () => {
    expect(RECOVERABLE_VERIFY_ERROR_CODES.has("STALE_QUOTE")).toBe(true);
    expect(RECOVERABLE_VERIFY_ERROR_CODES.has("CONFIG_DRIFT")).toBe(true);
    expect(RECOVERABLE_VERIFY_ERROR_CODES.has("ROUTE_MISMATCH")).toBe(true);
    expect(RECOVERABLE_VERIFY_ERROR_CODES.has("UNSUPPORTED_ASSET")).toBe(true);
    expect(RECOVERABLE_VERIFY_ERROR_CODES.has("SLIPPAGE_EXCEEDED")).toBe(false);
    expect(RECOVERABLE_VERIFY_ERROR_CODES.has("INVALID_QUOTE")).toBe(false);
  });
});
