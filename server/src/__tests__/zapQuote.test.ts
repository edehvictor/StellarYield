import { quoteFallback, getZapQuote } from "../services/zapQuote";

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
});

describe("getZapQuote", () => {
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
});
