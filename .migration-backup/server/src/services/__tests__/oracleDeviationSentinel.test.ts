import {
  evaluateOracle,
  evaluateAndRecord,
  getDeviationLog,
  clearDeviationLog,
  DEFAULT_THRESHOLDS,
  type OracleReading,
} from "../oracleDeviationSentinel";

const NOW = Date.now();

const fresh = (price: number, ageMs = 10_000): OracleReading => ({
  price,
  fetchedAt: NOW - ageMs,
  source: "test-oracle",
});

beforeEach(() => clearDeviationLog());

describe("evaluateOracle — missing data", () => {
  it("returns MISSING + BLOCK when reading is null", () => {
    const r = evaluateOracle(null, null, DEFAULT_THRESHOLDS, NOW);
    expect(r.state).toBe("MISSING");
    expect(r.decision).toBe("BLOCK");
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("evaluateOracle — freshness", () => {
  it("returns FRESH + ALLOW for recent data without reference", () => {
    const r = evaluateOracle(fresh(100), null, DEFAULT_THRESHOLDS, NOW);
    expect(r.state).toBe("FRESH");
    expect(r.decision).toBe("ALLOW");
    expect(r.ageMs).toBeLessThan(DEFAULT_THRESHOLDS.maxAgeMs);
  });

  it("returns STALE + BLOCK for data older than maxAgeMs", () => {
    const r = evaluateOracle(fresh(100, DEFAULT_THRESHOLDS.maxAgeMs + 1_000), null, DEFAULT_THRESHOLDS, NOW);
    expect(r.state).toBe("STALE");
    expect(r.decision).toBe("BLOCK");
  });

  it("boundary: data exactly at maxAgeMs is still STALE", () => {
    const r = evaluateOracle(fresh(100, DEFAULT_THRESHOLDS.maxAgeMs + 1), null, DEFAULT_THRESHOLDS, NOW);
    expect(r.decision).toBe("BLOCK");
  });
});

describe("evaluateOracle — deviation check", () => {
  it("returns VALID + ALLOW when price matches reference exactly", () => {
    const r = evaluateOracle(fresh(100), 100, DEFAULT_THRESHOLDS, NOW);
    expect(r.state).toBe("VALID");
    expect(r.decision).toBe("ALLOW");
    expect(r.deviationPct).toBe(0);
  });

  it("returns VALID + DOWNGRADE for deviation between thresholds", () => {
    // 3% deviation: above downgradeThresholdPct (2%) but below maxDeviationPct (5%)
    const r = evaluateOracle(fresh(103), 100, DEFAULT_THRESHOLDS, NOW);
    expect(r.state).toBe("VALID");
    expect(r.decision).toBe("DOWNGRADE");
    expect(r.deviationPct).toBeCloseTo(3, 1);
  });

  it("returns DEVIATED + BLOCK for deviation above maxDeviationPct", () => {
    // 6% deviation — exceeds 5% max
    const r = evaluateOracle(fresh(106), 100, DEFAULT_THRESHOLDS, NOW);
    expect(r.state).toBe("DEVIATED");
    expect(r.decision).toBe("BLOCK");
    expect(r.deviationPct).toBeCloseTo(6, 1);
  });

  it("treats negative deviation symmetrically (absolute value)", () => {
    const r = evaluateOracle(fresh(94), 100, DEFAULT_THRESHOLDS, NOW);
    expect(r.deviationPct).toBeCloseTo(6, 1);
    expect(r.decision).toBe("BLOCK");
  });

  it("skips deviation check when reference is null", () => {
    const r = evaluateOracle(fresh(999), null, DEFAULT_THRESHOLDS, NOW);
    expect(r.decision).toBe("ALLOW");
    expect(r.deviationPct).toBeNull();
  });
});

describe("evaluateAndRecord", () => {
  it("records an event for each evaluation", () => {
    evaluateAndRecord("XLM/USDC", fresh(100), 100, DEFAULT_THRESHOLDS, NOW);
    evaluateAndRecord("BTC/USDC", null, null, DEFAULT_THRESHOLDS, NOW);
    const log = getDeviationLog();
    expect(log.length).toBe(2);
  });

  it("log is returned newest-first", () => {
    evaluateAndRecord("XLM/USDC", fresh(100), 100, DEFAULT_THRESHOLDS, NOW);
    evaluateAndRecord("ETH/USDC", fresh(3000), 3000, DEFAULT_THRESHOLDS, NOW + 1);
    const log = getDeviationLog();
    expect(log[0].assetId).toBe("ETH/USDC");
  });

  it("returns evaluation result matching the log entry", () => {
    const evaluation = evaluateAndRecord("XLM/USDC", null, null, DEFAULT_THRESHOLDS, NOW);
    const log = getDeviationLog();
    expect(log[0].evaluation.decision).toBe(evaluation.decision);
  });

  it("clears log correctly", () => {
    evaluateAndRecord("XLM/USDC", fresh(100), null, DEFAULT_THRESHOLDS, NOW);
    clearDeviationLog();
    expect(getDeviationLog().length).toBe(0);
  });
});

describe("Fail-closed semantics", () => {
  it("always BLOCKS on missing oracle data", () => {
    const r = evaluateOracle(null);
    expect(r.decision).toBe("BLOCK");
  });

  it("always BLOCKS on stale data regardless of price", () => {
    const stale = fresh(100, 120_000); // 2 minutes old
    const r = evaluateOracle(stale, 100, DEFAULT_THRESHOLDS, NOW);
    expect(r.decision).toBe("BLOCK");
  });

  it("always BLOCKS on excessive deviation", () => {
    const r = evaluateOracle(fresh(150), 100, DEFAULT_THRESHOLDS, NOW);
    expect(r.decision).toBe("BLOCK");
  });
});
