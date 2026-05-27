import {
  recordFlowEvent,
  computePressureMetrics,
  setVaultThresholds,
  clearVaultEvents,
  getAllVaultPressure,
  DEFAULT_WINDOW_MS,
} from "../vaultPressureService";

const VAULT = "vault-001";
const NOW = Date.now();

beforeEach(() => clearVaultEvents(VAULT));

describe("recordFlowEvent + computePressureMetrics", () => {
  it("returns zero velocities for a vault with no events", () => {
    const m = computePressureMetrics(VAULT, DEFAULT_WINDOW_MS, NOW);
    expect(m.inflowVelocity).toBe(0);
    expect(m.outflowVelocity).toBe(0);
    expect(m.eventCount).toBe(0);
    expect(m.inflowPressure).toBe("NORMAL");
  });

  it("accumulates inflow events within the window", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(1000), timestamp: NOW - 1_000 });
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(2000), timestamp: NOW - 500 });
    const m = computePressureMetrics(VAULT, DEFAULT_WINDOW_MS, NOW);
    expect(m.totalInflowInWindow).toBe(BigInt(3000));
    expect(m.totalOutflowInWindow).toBe(BigInt(0));
    expect(m.inflowVelocity).toBeGreaterThan(0);
  });

  it("accumulates outflow events correctly", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "outflow", amount: BigInt(5000), timestamp: NOW - 1_000 });
    const m = computePressureMetrics(VAULT, DEFAULT_WINDOW_MS, NOW);
    expect(m.totalOutflowInWindow).toBe(BigInt(5000));
    expect(m.outflowVelocity).toBeGreaterThan(0);
    expect(m.netVelocity).toBeLessThan(0);
  });

  it("excludes events outside the sliding window", () => {
    const outside = NOW - DEFAULT_WINDOW_MS - 1_000;
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(99999), timestamp: outside });
    const m = computePressureMetrics(VAULT, DEFAULT_WINDOW_MS, NOW);
    expect(m.totalInflowInWindow).toBe(BigInt(0));
    expect(m.eventCount).toBe(0);
  });

  it("counts net velocity correctly when both directions present", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(3000), timestamp: NOW - 1_000 });
    recordFlowEvent({ vaultId: VAULT, direction: "outflow", amount: BigInt(1000), timestamp: NOW - 1_000 });
    const m = computePressureMetrics(VAULT, DEFAULT_WINDOW_MS, NOW);
    expect(m.netVelocity).toBeGreaterThan(0);
  });
});

describe("Pressure threshold classification", () => {
  beforeEach(() => {
    setVaultThresholds(VAULT, {
      baselineVelocity: 10,
      elevatedBps: 100,
      highBps: 200,
      criticalBps: 400,
    });
  });

  it("classifies NORMAL when velocity is below baseline", () => {
    // 5 USDC/s over a 1-second window (below 10 USDC/s baseline)
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(5), timestamp: NOW - 900 });
    const m = computePressureMetrics(VAULT, 1_000, NOW);
    expect(m.inflowPressure).toBe("NORMAL");
  });

  it("classifies ELEVATED when 1× baseline exceeded", () => {
    // 15 USDC in 1 s = 15/s > 10/s (1× = elevated)
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(15), timestamp: NOW - 500 });
    const m = computePressureMetrics(VAULT, 1_000, NOW);
    expect(m.inflowPressure).toBe("ELEVATED");
  });

  it("classifies HIGH when 2× baseline exceeded", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "outflow", amount: BigInt(25), timestamp: NOW - 500 });
    const m = computePressureMetrics(VAULT, 1_000, NOW);
    expect(m.outflowPressure).toBe("HIGH");
  });

  it("classifies CRITICAL when 4× baseline exceeded", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "outflow", amount: BigInt(50), timestamp: NOW - 500 });
    const m = computePressureMetrics(VAULT, 1_000, NOW);
    expect(m.outflowPressure).toBe("CRITICAL");
  });
});

describe("getAllVaultPressure", () => {
  it("returns metrics for all tracked vaults", () => {
    const v2 = "vault-002";
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(100), timestamp: NOW });
    recordFlowEvent({ vaultId: v2, direction: "outflow", amount: BigInt(200), timestamp: NOW });
    const all = getAllVaultPressure();
    const ids = all.map((m) => m.vaultId);
    expect(ids).toContain(VAULT);
    expect(ids).toContain(v2);
    clearVaultEvents(v2);
  });
});
