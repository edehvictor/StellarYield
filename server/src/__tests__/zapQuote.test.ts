import {
  quoteFallback,
  getZapQuote,
  isQuoteExpired,
  verifyQuoteForExecution,
  getStoredQuote,
  clearQuoteCache,
  getQuoteTtlMs,
} from "../services/zapQuote";

// Mock yieldService to prevent real Stellar network calls during CI
jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "default", tvl: 10_000_000 },
    { protocolName: "Blend", tvl: 12_000_000 },
  ]),
}));

// Mock freezeService so no protocol is frozen by default — include new safety helpers
jest.mock("../services/freezeService", () => ({
  freezeService: {
    isFrozen: jest.fn().mockReturnValue(false),
    getFreezeStatus: jest.fn().mockReturnValue({ isFrozen: false }),
    isQuoteInvalidatedByFreeze: jest.fn().mockReturnValue(false),
    getLastFrozenAt: jest.fn().mockReturnValue(undefined),
  },
}));

describe("quoteFallback", () => {
  it("returns 1:1 when input and vault token match", () => {
    const q = quoteFallback({
      inputTokenContract: "CDTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      vaultTokenContract: "CDTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountInStroops: "10000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });
    expect(q.expectedAmountOutStroops).toBe("10000000");
    expect(q.source).toBe("fallback_rate");
    expect(q.isFallback).toBe(true);
    expect(q.quotedAt).toBeDefined();
    expect(q.minAmountOutStroops).toBeDefined();
  });

  it("scales by fallback ratio when tokens differ", () => {
    const prevNum = process.env.ZAP_FALLBACK_NUMERATOR;
    const prevDen = process.env.ZAP_FALLBACK_DENOMINATOR;
    process.env.ZAP_FALLBACK_NUMERATOR = "15";
    process.env.ZAP_FALLBACK_DENOMINATOR = "100";

    const q = quoteFallback({
      inputTokenContract: "A",
      vaultTokenContract: "B",
      amountInStroops: "100000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    expect(q.expectedAmountOutStroops).toBe("15000000");
    expect(q.path).toHaveLength(2);
    expect(q.isFallback).toBe(true);

    if (prevNum === undefined) {
      delete process.env.ZAP_FALLBACK_NUMERATOR;
    } else {
      process.env.ZAP_FALLBACK_NUMERATOR = prevNum;
    }
    if (prevDen === undefined) {
      delete process.env.ZAP_FALLBACK_DENOMINATOR;
    } else {
      process.env.ZAP_FALLBACK_DENOMINATOR = prevDen;
    }
  });

  it("includes quotedAt timestamp", () => {
    const before = Date.now();
    const q = quoteFallback({
      inputTokenContract: "A",
      vaultTokenContract: "A",
      amountInStroops: "1000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });
    const after = Date.now();
    const ts = new Date(q.quotedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("includes minAmountOutStroops", () => {
    const q = quoteFallback({
      inputTokenContract: "A",
      vaultTokenContract: "A",
      amountInStroops: "5000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });
    expect(q.minAmountOutStroops).toBe("5000000");
  });

  it("includes safety envelope fields", () => {
    const q = quoteFallback({
      inputTokenContract: "A",
      vaultTokenContract: "B",
      amountInStroops: "1000",
      inputDecimals: 7,
      vaultDecimals: 7,
      protocol: "Blend",
    });
    expect(q.quoteId).toBeDefined();
    expect(q.expiresAt).toBeDefined();
    expect(q.ttlMs).toBeDefined();
    expect(q.inputTokenContract).toBe("A");
    expect(q.vaultTokenContract).toBe("B");
    expect(q.amountInStroops).toBe("1000");
    expect(q.protocol).toBe("Blend");
    expect(q.freezeCheckedAt).toBeDefined();
    expect(q.quoteSource).toBe("fallback_rate");
  });
});

describe("getZapQuote", () => {
  beforeEach(() => {
    clearQuoteCache();
  });

  it("uses fallback when router env is not set", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    const q = await getZapQuote({
      inputTokenContract: "SAME",
      vaultTokenContract: "SAME",
      amountInStroops: "42",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    expect(q.expectedAmountOutStroops).toBe("42");
    expect(q.isFallback).toBe(true);
    expect(q.quotedAt).toBeDefined();
    expect(typeof q.quoteAgeMs).toBe("number");

    if (prevSim !== undefined) {
      process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    }
    if (prevRouter !== undefined) {
      process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    }
  });

  it("falls back if simulated router times out", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    const prevTimeout = process.env.SOROBAN_RPC_TIMEOUT_MS;

    process.env.DEX_ROUTER_CONTRACT_ID = "CRTG2XYZ";
    process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = "GABC123";
    process.env.SOROBAN_RPC_TIMEOUT_MS = "100";

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const StellarSdk = require("@stellar/stellar-sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(StellarSdk.rpc.Server.prototype, "getAccount").mockResolvedValue({} as any);
    jest.spyOn(StellarSdk.rpc.Server.prototype, "simulateTransaction").mockImplementation(() => {
      return new Promise((resolve) => setTimeout(resolve, 300));
    });

    const q = await getZapQuote({
      inputTokenContract: "SAME",
      vaultTokenContract: "SAME",
      amountInStroops: "42",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    expect(q.expectedAmountOutStroops).toBe("42");
    expect(q.source).toBe("fallback_rate");
    expect(q.isFallback).toBe(true);

    jest.restoreAllMocks();

    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;

    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    if (prevTimeout !== undefined) process.env.SOROBAN_RPC_TIMEOUT_MS = prevTimeout;
    else delete process.env.SOROBAN_RPC_TIMEOUT_MS;
  });

  describe("quote metadata", () => {
    it("includes quotedAt and minAmountOutStroops", async () => {
      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const q = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

      expect(q.quotedAt).toBeDefined();
      expect(() => new Date(q.quotedAt)).not.toThrow();
      expect(q.minAmountOutStroops).toBeDefined();
      expect(BigInt(q.minAmountOutStroops) > 0n).toBe(true);
      expect(typeof q.quoteAgeMs).toBe("number");

      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });

    it("marks fallback quotes correctly", async () => {
      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const q = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

      expect(q.isFallback).toBe(true);

      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });
  });

  describe("quote safety envelope", () => {
    it("assigns quoteId, expiresAt, ttlMs and persists assumptions", async () => {
      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const q = await getZapQuote({
        inputTokenContract: "CXLM",
        vaultTokenContract: "CVAULT",
        amountInStroops: "10000000",
        inputDecimals: 7,
        vaultDecimals: 7,
        protocol: "Blend",
      });

      expect(q.quoteId).toBeDefined();
      expect(typeof q.quoteId).toBe("string");
      expect(q.quoteId.length).toBeGreaterThan(5);
      expect(q.expiresAt).toBeDefined();
      expect(() => new Date(q.expiresAt)).not.toThrow();
      expect(new Date(q.expiresAt).getTime()).toBeGreaterThan(new Date(q.quotedAt).getTime());
      expect(q.ttlMs).toBe(getQuoteTtlMs());
      expect(q.inputTokenContract).toBe("CXLM");
      expect(q.vaultTokenContract).toBe("CVAULT");
      expect(q.amountInStroops).toBe("10000000");
      expect(q.protocol).toBe("Blend");
      expect(q.freezeCheckedAt).toBeDefined();
      expect(q.quoteSource).toBe(q.source);
      expect(q.quoteSignature).toBeDefined();
      // Persisted — can be retrieved via getStoredQuote
      const stored = getStoredQuote(q.quoteId);
      expect(stored).toBeDefined();
      expect(stored?.quoteId).toBe(q.quoteId);

      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });

    it("respects ZAP_QUOTE_TTL_MS env and clamps to safe bounds", async () => {
      const prevTtl = process.env.ZAP_QUOTE_TTL_MS;
      process.env.ZAP_QUOTE_TTL_MS = "120000";

      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const q = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      expect(q.ttlMs).toBe(120000);
      expect(new Date(q.expiresAt).getTime() - new Date(q.quotedAt).getTime()).toBe(120000);

      if (prevTtl === undefined) delete process.env.ZAP_QUOTE_TTL_MS;
      else process.env.ZAP_QUOTE_TTL_MS = prevTtl;
      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });

    it("distinct quotes get distinct ids", async () => {
      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const q1 = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      const q2 = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      expect(q1.quoteId).not.toBe(q2.quoteId);

      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });
  });

  describe("slippage edge cases", () => {
    it("clamps negative slippage to 0.1% floor", async () => {
      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const q = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: -5 as unknown as number,
      });
      // Model slippage for 1M / 10M = ~1.1% ; effective should be model (clamped user 0.001 is lower)
      expect(q.slippageApplied).toBeGreaterThanOrEqual(0.001);
      expect(q.slippageApplied).toBeLessThanOrEqual(0.15);
      expect(BigInt(q.minAmountOutStroops)).toBeLessThanOrEqual(BigInt(q.expectedAmountOutStroops));

      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });

    it("clamps zero slippage to floor", async () => {
      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const q = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0,
      });
      expect(q.slippageApplied).toBeGreaterThanOrEqual(0.001);

      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });

    it("clamps excessive slippage to 15% ceiling", async () => {
      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const q = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.5, // 50% -> should clamp to 0.15
      });
      expect(q.slippageApplied).toBeLessThanOrEqual(0.15);
      expect(q.slippageApplied).toBeGreaterThanOrEqual(0.001);

      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });

    it("uses model slippage when user tolerance not provided", async () => {
      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const q = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      // Default model for 1M/10M => ~0.011
      expect(q.slippageApplied).toBeCloseTo(0.011, 2);

      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });

    it("effective slippage is max(model, user) within safe bounds", async () => {
      const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
      const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      delete process.env.DEX_ROUTER_CONTRACT_ID;
      delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

      const qLow = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "100000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.05, // 5% > model ~0.002
      });
      expect(qLow.slippageApplied).toBeCloseTo(0.05, 3);

      const qHighModel = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "5000000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.005, // 0.5% ; model for 5M/10M = 0.001+0.05=0.051 => model wins
      });
      expect(qHighModel.slippageApplied).toBeGreaterThan(0.04);

      if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
      else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
      if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
      else delete process.env.DEX_ROUTER_CONTRACT_ID;
    });
  });
});

describe("isQuoteExpired", () => {
  it("returns false for fresh quote", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    const q = await getZapQuote({
      inputTokenContract: "A",
      vaultTokenContract: "B",
      amountInStroops: "1000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });
    expect(isQuoteExpired(q)).toBe(false);

    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;
  });

  it("returns true when expiresAt is in the past", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const quotedAt = new Date(Date.now() - 70_000).toISOString();
    expect(isQuoteExpired({ quotedAt, expiresAt: past } as any)).toBe(true);
  });

  it("returns true for NaN dates", () => {
    expect(isQuoteExpired({ quotedAt: "invalid", expiresAt: "invalid" } as any)).toBe(true);
  });
});

describe("verifyQuoteForExecution", () => {
  beforeEach(() => {
    clearQuoteCache();
    jest.clearAllMocks();
    // Reset freeze mocks to non-frozen default
    const { freezeService } = require("../services/freezeService");
    freezeService.isFrozen.mockReturnValue(false);
    freezeService.isQuoteInvalidatedByFreeze.mockReturnValue(false);
    freezeService.getFreezeStatus.mockReturnValue({ isFrozen: false });
  });

  it("rejects stale/expired quotes", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    const prevTtl = process.env.ZAP_QUOTE_TTL_MS;
    process.env.ZAP_QUOTE_TTL_MS = "50"; // will be clamped to 5000, so we manually craft expiry

    const q = await getZapQuote({
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      amountInStroops: "10000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });
    // Force expiry in past
    const stored = getStoredQuote(q.quoteId)!;
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();

    const result = verifyQuoteForExecution({
      quoteId: q.quoteId,
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
    });
    expect(result.valid).toBe(false);
    expect(result.code).toBe("QUOTE_EXPIRED");

    if (prevTtl === undefined) delete process.env.ZAP_QUOTE_TTL_MS;
    else process.env.ZAP_QUOTE_TTL_MS = prevTtl;
    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;
  });

  it("rejects when asset pair changed", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    const q = await getZapQuote({
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      amountInStroops: "10000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    const result = verifyQuoteForExecution({
      quoteId: q.quoteId,
      inputTokenContract: "CUSDC", // changed
      vaultTokenContract: "CVAULT",
    });
    expect(result.valid).toBe(false);
    expect(result.code).toBe("ASSET_MISMATCH");
    expect(result.reason).toMatch(/input.*CXLM/i);

    const result2 = verifyQuoteForExecution({
      quoteId: q.quoteId,
      inputTokenContract: "CXLM",
      vaultTokenContract: "COTHER",
    });
    expect(result2.valid).toBe(false);
    expect(result2.code).toBe("ASSET_MISMATCH");

    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;
  });

  it("rejects when route changed", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    const q = await getZapQuote({
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      amountInStroops: "10000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    const result = verifyQuoteForExecution({
      quoteId: q.quoteId,
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      path: [{ contractId: "CXLM" }, { contractId: "COTHER" }],
    });
    expect(result.valid).toBe(false);
    expect(result.code).toBe("ROUTE_MISMATCH");

    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;
  });

  it("rejects when quote was before protocol freeze", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    const q = await getZapQuote({
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      amountInStroops: "10000000",
      inputDecimals: 7,
      vaultDecimals: 7,
      protocol: "Blend",
    });

    const { freezeService } = require("../services/freezeService");
    freezeService.isQuoteInvalidatedByFreeze.mockReturnValue(true);

    const result = verifyQuoteForExecution({
      quoteId: q.quoteId,
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      protocol: "Blend",
    });
    expect(result.valid).toBe(false);
    expect(result.code).toBe("FROZEN");
    expect(result.reason).toMatch(/freeze/i);

    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;
  });

  it("rejects unknown quoteId", () => {
    const result = verifyQuoteForExecution({
      quoteId: "non-existent-id",
      inputTokenContract: "A",
      vaultTokenContract: "B",
    });
    expect(result.valid).toBe(false);
    expect(result.code).toBe("QUOTE_NOT_FOUND");
  });

  it("accepts fresh valid quote with matching assumptions", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    const q = await getZapQuote({
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      amountInStroops: "10000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    const result = verifyQuoteForExecution({
      quoteId: q.quoteId,
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      amountInStroops: "10000000",
      path: q.path,
    });
    expect(result.valid).toBe(true);
    expect(result.storedQuote?.quoteId).toBe(q.quoteId);

    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;
  });

  it("distinguishes fallback quotes via isFallback", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    const q = await getZapQuote({
      inputTokenContract: "A",
      vaultTokenContract: "B",
      amountInStroops: "1000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });
    expect(q.isFallback).toBe(true);
    expect(q.source).toBe("fallback_rate");

    const result = verifyQuoteForExecution({
      quoteId: q.quoteId,
      inputTokenContract: "A",
      vaultTokenContract: "B",
    });
    expect(result.valid).toBe(true);
    expect(result.isFallback).toBe(true);

    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;
  });
});

describe("quote persistence and signing", () => {
  beforeEach(() => clearQuoteCache());

  it("persists quote assumptions retrievably and signs them", async () => {
    const prevRouter = process.env.DEX_ROUTER_CONTRACT_ID;
    const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    const q = await getZapQuote({
      inputTokenContract: "CXLM",
      vaultTokenContract: "CVAULT",
      amountInStroops: "5000000",
      inputDecimals: 7,
      vaultDecimals: 7,
      protocol: "Soroswap",
    });

    const stored = getStoredQuote(q.quoteId);
    expect(stored).toBeDefined();
    expect(stored?.inputTokenContract).toBe("CXLM");
    expect(stored?.vaultTokenContract).toBe("CVAULT");
    expect(stored?.amountInStroops).toBe("5000000");
    expect(stored?.expectedAmountOutStroops).toBe(q.expectedAmountOutStroops);
    expect(stored?.minAmountOutStroops).toBe(q.minAmountOutStroops);
    expect(stored?.slippageApplied).toBe(q.slippageApplied);
    expect(stored?.source).toBe(q.source);
    expect(stored?.protocol).toBe("Soroswap");
    expect(stored?.quoteSignature).toMatch(/^[a-f0-9]{32}$/);

    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;
  });
});
