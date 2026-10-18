import { quoteFallback, getZapQuote, detectFeeDrift, getFeeDriftWarnThreshold, getFeeDriftErrorThreshold } from "../services/zapQuote";

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

// ---------------------------------------------------------------------------
// detectFeeDrift — regression tests for fee drift detection (issue #1101)
// ---------------------------------------------------------------------------

describe("detectFeeDrift", () => {
  // --- null / no-warning cases ---

  it("returns null when preview and execution fee are identical", () => {
    expect(detectFeeDrift("1000000", "1000000")).toBeNull();
  });

  it("returns null for a tiny rounding difference below the warn threshold", () => {
    // 1 stroop difference on 1_000_000 → 0.0001% — well below 5%
    expect(detectFeeDrift("1000000", "1000001")).toBeNull();
  });

  it("returns null for a 1% delta (below the 5% default warn threshold)", () => {
    // 1% of 1_000_000 = 10_000
    expect(detectFeeDrift("1000000", "1010000")).toBeNull();
  });

  it("returns null for a 4.9% delta (just below warn threshold)", () => {
    // 4.9% of 1_000_000 = 49_000
    expect(detectFeeDrift("1000000", "1049000")).toBeNull();
  });

  // --- warn-level cases ---

  it("emits a warn-level warning at exactly 5% drift", () => {
    // 5% of 1_000_000 = 50_000
    const result = detectFeeDrift("1000000", "1050000");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("FEE_DRIFT");
    expect(result?.severity).toBe("warn");
    expect(result?.deltaRelative).toBeCloseTo(0.05, 5);
    expect(result?.previewFee).toBe("1000000");
    expect(result?.executionFee).toBe("1050000");
    expect(result?.deltaAbs).toBe("50000");
    expect(result?.message).toContain("drifted");
  });

  it("emits a warn-level warning for a 10% increase", () => {
    // 10% of 2_000_000 = 200_000
    const result = detectFeeDrift("2000000", "2200000");
    expect(result?.severity).toBe("warn");
    expect(result?.deltaRelative).toBeCloseTo(0.1, 5);
  });

  it("emits a warn-level warning for a fee decrease (negative drift)", () => {
    // Execution fee is 8% *lower* than preview — still a material change
    const result = detectFeeDrift("1000000", "920000");
    expect(result?.severity).toBe("warn");
    expect(result?.deltaRelative).toBeCloseTo(0.08, 5);
  });

  // --- error-level cases (≥ 15%) ---

  it("emits an error-level warning at exactly 15% drift", () => {
    // 15% of 1_000_000 = 150_000
    const result = detectFeeDrift("1000000", "1150000");
    expect(result?.severity).toBe("error");
    expect(result?.deltaRelative).toBeCloseTo(0.15, 5);
    expect(result?.message).toContain("re-quote");
  });

  it("emits an error-level warning for a 50% fee increase", () => {
    const result = detectFeeDrift("1000000", "1500000");
    expect(result?.severity).toBe("error");
    expect(result?.deltaRelative).toBeCloseTo(0.5, 5);
  });

  it("emits an error-level warning for a large fee decrease", () => {
    // 20% decrease
    const result = detectFeeDrift("1000000", "800000");
    expect(result?.severity).toBe("error");
    expect(result?.deltaRelative).toBeCloseTo(0.2, 5);
  });

  // --- edge cases ---

  it("returns null when previewFee is zero (avoids division by zero)", () => {
    expect(detectFeeDrift("0", "1000000")).toBeNull();
  });

  it("handles large stroop values correctly (bigint arithmetic)", () => {
    // 10_000_000_000_000 stroops, 10% drift
    const big = BigInt("10000000000000");
    const drifted = (big * 110n / 100n).toString();
    const result = detectFeeDrift(big.toString(), drifted);
    expect(result?.severity).toBe("warn");
    expect(result?.deltaRelative).toBeCloseTo(0.1, 5);
  });

  // --- threshold override via env vars ---

  it("respects a custom warn threshold set via FEE_DRIFT_WARN_THRESHOLD", () => {
    const prev = process.env.FEE_DRIFT_WARN_THRESHOLD;
    process.env.FEE_DRIFT_WARN_THRESHOLD = "0.10"; // 10% warn threshold

    // 7% drift should NOT warn with a 10% threshold
    const below = detectFeeDrift("1000000", "1070000");
    expect(below).toBeNull();

    // 11% drift should warn
    const above = detectFeeDrift("1000000", "1110000");
    expect(above?.severity).toBe("warn");

    if (prev === undefined) delete process.env.FEE_DRIFT_WARN_THRESHOLD;
    else process.env.FEE_DRIFT_WARN_THRESHOLD = prev;
  });

  it("respects a custom error threshold set via FEE_DRIFT_ERROR_THRESHOLD", () => {
    const prevWarn = process.env.FEE_DRIFT_WARN_THRESHOLD;
    const prevError = process.env.FEE_DRIFT_ERROR_THRESHOLD;
    process.env.FEE_DRIFT_WARN_THRESHOLD = "0.05";
    process.env.FEE_DRIFT_ERROR_THRESHOLD = "0.20"; // 20% error threshold

    // 16% drift should be "warn" (below the 20% error threshold)
    const warnResult = detectFeeDrift("1000000", "1160000");
    expect(warnResult?.severity).toBe("warn");

    // 21% drift should be "error"
    const errorResult = detectFeeDrift("1000000", "1210000");
    expect(errorResult?.severity).toBe("error");

    if (prevWarn === undefined) delete process.env.FEE_DRIFT_WARN_THRESHOLD;
    else process.env.FEE_DRIFT_WARN_THRESHOLD = prevWarn;
    if (prevError === undefined) delete process.env.FEE_DRIFT_ERROR_THRESHOLD;
    else process.env.FEE_DRIFT_ERROR_THRESHOLD = prevError;
  });
});

describe("getFeeDriftWarnThreshold / getFeeDriftErrorThreshold", () => {
  it("returns defaults when env vars are not set", () => {
    const prevWarn = process.env.FEE_DRIFT_WARN_THRESHOLD;
    const prevError = process.env.FEE_DRIFT_ERROR_THRESHOLD;
    delete process.env.FEE_DRIFT_WARN_THRESHOLD;
    delete process.env.FEE_DRIFT_ERROR_THRESHOLD;

    expect(getFeeDriftWarnThreshold()).toBeCloseTo(0.05);
    expect(getFeeDriftErrorThreshold()).toBeCloseTo(0.15);

    if (prevWarn !== undefined) process.env.FEE_DRIFT_WARN_THRESHOLD = prevWarn;
    if (prevError !== undefined) process.env.FEE_DRIFT_ERROR_THRESHOLD = prevError;
  });

  it("ignores non-numeric env var values and falls back to defaults", () => {
    const prev = process.env.FEE_DRIFT_WARN_THRESHOLD;
    process.env.FEE_DRIFT_WARN_THRESHOLD = "not-a-number";
    expect(getFeeDriftWarnThreshold()).toBeCloseTo(0.05);
    if (prev === undefined) delete process.env.FEE_DRIFT_WARN_THRESHOLD;
    else process.env.FEE_DRIFT_WARN_THRESHOLD = prev;
  });
});
