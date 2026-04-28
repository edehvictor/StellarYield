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

    jest.restoreAllMocks();

    if (prevRouter !== undefined) process.env.DEX_ROUTER_CONTRACT_ID = prevRouter;
    else delete process.env.DEX_ROUTER_CONTRACT_ID;

    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;

    if (prevTimeout !== undefined) process.env.SOROBAN_RPC_TIMEOUT_MS = prevTimeout;
    else delete process.env.SOROBAN_RPC_TIMEOUT_MS;
  });
});
