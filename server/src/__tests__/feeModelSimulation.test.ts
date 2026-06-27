import {
  computeDynamicFee,
  generateSyntheticData,
  runSimulation,
  MIN_FEE_BPS,
  MAX_FEE_BPS,
  MOVING_AVG_WINDOW,
  type ApyDataPoint,
  type SimulationResult,
} from "../analytics/feeModelSimulation";

function makeDeterministicData(): ApyDataPoint[] {
  const data: ApyDataPoint[] = [];
  for (let day = 0; day < 180; day++) {
    let apyBps: number;
    if (day < 30) {
      apyBps = 700;
    } else if (day < 75) {
      const progress = (day - 30) / 45;
      apyBps = 1000 + Math.floor(progress * 2500);
    } else if (day < 105) {
      apyBps = 5000;
    } else if (day < 135) {
      const progress = (day - 105) / 30;
      apyBps = 2000 - Math.floor(progress * 1200);
    } else {
      apyBps = 1800;
    }
    data.push({ day, apyBps: Math.max(100, apyBps) });
  }
  return data;
}

describe("Dynamic Fee Model Simulation Snapshot Tests", () => {
  describe("computeDynamicFee", () => {
    it("returns MIN_FEE_BPS for empty history", () => {
      expect(computeDynamicFee([])).toBe(MIN_FEE_BPS);
    });

    it("clamps to MIN_FEE_BPS for very low APY", () => {
      const history = Array(20).fill(100);
      const fee = computeDynamicFee(history);
      expect(fee).toBe(MIN_FEE_BPS);
    });

    it("clamps to MAX_FEE_BPS for very high APY", () => {
      const history = Array(20).fill(50_000);
      const fee = computeDynamicFee(history);
      expect(fee).toBe(MAX_FEE_BPS);
    });

    it("uses only the last MOVING_AVG_WINDOW entries", () => {
      const oldHistory = Array(50).fill(100);
      const recentHistory = Array(MOVING_AVG_WINDOW).fill(5000);
      const combined = [...oldHistory, ...recentHistory];

      const feeAll = computeDynamicFee(combined);
      const feeRecent = computeDynamicFee(recentHistory);
      expect(feeAll).toBe(feeRecent);
    });

    it("computes fee proportional to average APY", () => {
      const fee1 = computeDynamicFee(Array(10).fill(2000));
      const fee2 = computeDynamicFee(Array(10).fill(4000));
      expect(fee2).toBeGreaterThan(fee1);
    });
  });

  describe("phase transition snapshots (deterministic data)", () => {
    let results: SimulationResult[];

    beforeAll(() => {
      const data = makeDeterministicData();
      results = runSimulation(data);
    });

    it("produces 6 period results (5 phases + full)", () => {
      expect(results).toHaveLength(6);
    });

    it("Phase 1 (Low yield): dynamic fee < static fee", () => {
      const phase1 = results[0];
      expect(phase1.period).toContain("Low yield");
      expect(phase1.avgDynamicFeeBps).toBeLessThan(500);
      expect(phase1.dynamicFeeRevenue).toBeLessThan(phase1.staticFeeRevenue);
    });

    it("Phase 2 (Rising yield): dynamic fee increases through phase", () => {
      const phase2 = results[1];
      expect(phase2.period).toContain("Rising yield");
      expect(phase2.avgDynamicFeeBps).toBeGreaterThanOrEqual(MIN_FEE_BPS);
      expect(phase2.avgDynamicFeeBps).toBeLessThanOrEqual(MAX_FEE_BPS);
    });

    it("Phase 3 (High yield): dynamic fee at or near MAX", () => {
      const phase3 = results[2];
      expect(phase3.period).toContain("High yield");
      expect(phase3.avgDynamicFeeBps).toBeGreaterThan(400);
      expect(phase3.dynamicFeeRevenue).toBeGreaterThan(0);
    });

    it("Phase 4 (Correction): dynamic fee decreases", () => {
      const phase4 = results[3];
      expect(phase4.period).toContain("Correction");
      expect(phase4.avgDynamicFeeBps).toBeLessThan(results[2].avgDynamicFeeBps);
    });

    it("Phase 5 (Recovery): dynamic fee stabilizes in mid-range", () => {
      const phase5 = results[4];
      expect(phase5.period).toContain("Recovery");
      expect(phase5.avgDynamicFeeBps).toBeGreaterThanOrEqual(MIN_FEE_BPS);
      expect(phase5.avgDynamicFeeBps).toBeLessThanOrEqual(MAX_FEE_BPS);
    });

    it("Full period summary has positive revenue for both models", () => {
      const full = results[5];
      expect(full.period).toContain("Full");
      expect(full.staticFeeRevenue).toBeGreaterThan(0);
      expect(full.dynamicFeeRevenue).toBeGreaterThan(0);
    });
  });

  describe("fee bounds invariants", () => {
    it("dynamic fee never drops below MIN_FEE_BPS", () => {
      const data = makeDeterministicData();
      const apyHistory: number[] = [];
      for (const point of data) {
        apyHistory.push(point.apyBps);
        const fee = computeDynamicFee(apyHistory);
        expect(fee).toBeGreaterThanOrEqual(MIN_FEE_BPS);
      }
    });

    it("dynamic fee never exceeds MAX_FEE_BPS", () => {
      const data = makeDeterministicData();
      const apyHistory: number[] = [];
      for (const point of data) {
        apyHistory.push(point.apyBps);
        const fee = computeDynamicFee(apyHistory);
        expect(fee).toBeLessThanOrEqual(MAX_FEE_BPS);
      }
    });
  });

  describe("moving average window boundaries", () => {
    it("fee stabilizes after window is filled", () => {
      const constant = 3000;
      const history: number[] = [];
      const fees: number[] = [];

      for (let i = 0; i < MOVING_AVG_WINDOW + 5; i++) {
        history.push(constant);
        fees.push(computeDynamicFee(history));
      }

      const afterWindow = fees.slice(MOVING_AVG_WINDOW);
      const allEqual = afterWindow.every((f) => f === afterWindow[0]);
      expect(allEqual).toBe(true);
    });

    it("abrupt APY change only fully impacts fee after window passes", () => {
      const lowHistory = Array(MOVING_AVG_WINDOW).fill(500);
      const feeBefore = computeDynamicFee(lowHistory);

      lowHistory.push(8000);
      const feeAfterOne = computeDynamicFee(lowHistory);

      const highHistory = Array(MOVING_AVG_WINDOW).fill(8000);
      const feeAfterFull = computeDynamicFee(highHistory);

      expect(feeAfterOne).toBeGreaterThan(feeBefore);
      expect(feeAfterOne).toBeLessThan(feeAfterFull);
    });
  });

  describe("static vs dynamic revenue comparison", () => {
    it("dynamic model produces different revenue than static in volatile markets", () => {
      const data = makeDeterministicData();
      const results = runSimulation(data);
      const full = results.find((r) => r.period.includes("Full"))!;
      expect(full.staticFeeRevenue).not.toBe(full.dynamicFeeRevenue);
    });

    it("low-yield phase dynamic revenue is lower than static", () => {
      const data = makeDeterministicData();
      const results = runSimulation(data);
      const lowYield = results[0];
      expect(lowYield.dynamicFeeRevenue).toBeLessThan(lowYield.staticFeeRevenue);
    });
  });

  describe("generateSyntheticData", () => {
    it("generates exactly 180 data points", () => {
      const data = generateSyntheticData();
      expect(data).toHaveLength(180);
    });

    it("all APY values are at least 100 bps", () => {
      const data = generateSyntheticData();
      for (const point of data) {
        expect(point.apyBps).toBeGreaterThanOrEqual(100);
      }
    });

    it("days are sequential 0-179", () => {
      const data = generateSyntheticData();
      for (let i = 0; i < 180; i++) {
        expect(data[i].day).toBe(i);
      }
    });
  });
});
