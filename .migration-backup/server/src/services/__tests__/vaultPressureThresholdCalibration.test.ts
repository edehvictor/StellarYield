/**
 * Vault Pressure Panel Threshold Calibration Tests (#834)
 *
 * Covers:
 *   - DEFAULT_THRESHOLDS regression pins (catch accidental config drift)
 *   - Exact threshold boundary conditions (NORMAL/ELEVATED/HIGH/CRITICAL)
 *   - Panel state semantics: calm, warning, critical
 *   - Rising utilization progression via event accumulation
 *   - Custom per-vault baseline calibration
 *   - Deterministic output guarantee: same inputs → same PressureLevel
 */

import {
  recordFlowEvent,
  computePressureMetrics,
  setVaultThresholds,
  clearVaultEvents,
  clearVaultThresholds,
  getPressureLevel,
  DEFAULT_THRESHOLDS,
  DEFAULT_WINDOW_MS,
  PressureThresholds,
} from "../vaultPressureService";

const NOW = Date.now();

// ── DEFAULT_THRESHOLDS calibration regression pins ────────────────────────────

describe("DEFAULT_THRESHOLDS calibration regression pins", () => {
  it("baseline velocity is pinned at 100 USDC/s", () => {
    expect(DEFAULT_THRESHOLDS.baselineVelocity).toBe(100);
  });

  it("elevatedBps is pinned at 100 (1× baseline)", () => {
    expect(DEFAULT_THRESHOLDS.elevatedBps).toBe(100);
  });

  it("highBps is pinned at 200 (2× baseline)", () => {
    expect(DEFAULT_THRESHOLDS.highBps).toBe(200);
  });

  it("criticalBps is pinned at 400 (4× baseline)", () => {
    expect(DEFAULT_THRESHOLDS.criticalBps).toBe(400);
  });

  it("default sliding window is pinned at 5 minutes (300 000 ms)", () => {
    expect(DEFAULT_WINDOW_MS).toBe(5 * 60 * 1_000);
  });
});

// ── NORMAL ↔ ELEVATED boundary ────────────────────────────────────────────────

describe("threshold boundary: NORMAL ↔ ELEVATED (elevatedBps = 100)", () => {
  it("velocity 99 → NORMAL (ratio 99 < 100 bps)", () => {
    expect(getPressureLevel(99)).toBe("NORMAL");
  });

  it("velocity 100 → ELEVATED at the exact elevated boundary", () => {
    expect(getPressureLevel(100)).toBe("ELEVATED");
  });

  it("velocity 100.001 → ELEVATED fractionally above the boundary", () => {
    expect(getPressureLevel(100.001)).toBe("ELEVATED");
  });

  it("velocity 0 → NORMAL (zero flow is always calm)", () => {
    expect(getPressureLevel(0)).toBe("NORMAL");
  });
});

// ── ELEVATED ↔ HIGH boundary ──────────────────────────────────────────────────

describe("threshold boundary: ELEVATED ↔ HIGH (highBps = 200)", () => {
  it("velocity 199 → ELEVATED (ratio 199 < 200 bps)", () => {
    expect(getPressureLevel(199)).toBe("ELEVATED");
  });

  it("velocity 200 → HIGH at the exact high boundary", () => {
    expect(getPressureLevel(200)).toBe("HIGH");
  });

  it("velocity 200.001 → HIGH fractionally above the boundary", () => {
    expect(getPressureLevel(200.001)).toBe("HIGH");
  });
});

// ── HIGH ↔ CRITICAL boundary ──────────────────────────────────────────────────

describe("threshold boundary: HIGH ↔ CRITICAL (criticalBps = 400)", () => {
  it("velocity 399 → HIGH (ratio 399 < 400 bps)", () => {
    expect(getPressureLevel(399)).toBe("HIGH");
  });

  it("velocity 400 → CRITICAL at the exact critical boundary", () => {
    expect(getPressureLevel(400)).toBe("CRITICAL");
  });

  it("velocity 1000 → CRITICAL well above the critical threshold", () => {
    expect(getPressureLevel(1000)).toBe("CRITICAL");
  });
});

// ── Panel states: calm, warning, critical ─────────────────────────────────────

describe("panel states: calm, warning, critical", () => {
  it("calm — zero velocity is NORMAL", () => {
    expect(getPressureLevel(0)).toBe("NORMAL");
  });

  it("calm — 50% of baseline velocity (50 USDC/s) is NORMAL", () => {
    expect(getPressureLevel(50)).toBe("NORMAL");
  });

  it("calm — 99% of baseline (99 USDC/s) remains NORMAL", () => {
    expect(getPressureLevel(99)).toBe("NORMAL");
  });

  it("warning (ELEVATED) — 150% of baseline (150 USDC/s)", () => {
    expect(getPressureLevel(150)).toBe("ELEVATED");
  });

  it("warning (HIGH) — 300% of baseline (300 USDC/s)", () => {
    expect(getPressureLevel(300)).toBe("HIGH");
  });

  it("critical — 500% of baseline (500 USDC/s) is CRITICAL", () => {
    expect(getPressureLevel(500)).toBe("CRITICAL");
  });

  it("critical — 10× baseline (1000 USDC/s) is CRITICAL", () => {
    expect(getPressureLevel(1000)).toBe("CRITICAL");
  });
});

// ── Rising utilization via event accumulation ─────────────────────────────────

describe("rising utilization via event accumulation", () => {
  const VAULT = "cal-vault-rising";

  beforeEach(() => {
    clearVaultEvents(VAULT);
    clearVaultThresholds(VAULT); // use DEFAULT_THRESHOLDS (baselineVelocity=100)
  });

  // 1-second window keeps math clean: amount (USDC) ≈ velocity (USDC/s)

  it("low inflow (50 USDC in 1 s) starts at NORMAL", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(50), timestamp: NOW - 500 });
    expect(computePressureMetrics(VAULT, 1_000, NOW).inflowPressure).toBe("NORMAL");
  });

  it("velocity crossing 1× baseline (100 USDC/s) escalates to ELEVATED", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(100), timestamp: NOW - 500 });
    expect(computePressureMetrics(VAULT, 1_000, NOW).inflowPressure).toBe("ELEVATED");
  });

  it("velocity crossing 2× baseline (200 USDC/s) escalates to HIGH", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(200), timestamp: NOW - 500 });
    expect(computePressureMetrics(VAULT, 1_000, NOW).inflowPressure).toBe("HIGH");
  });

  it("velocity crossing 4× baseline (400 USDC/s) escalates to CRITICAL", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(400), timestamp: NOW - 500 });
    expect(computePressureMetrics(VAULT, 1_000, NOW).inflowPressure).toBe("CRITICAL");
  });

  it("full NORMAL → ELEVATED → HIGH → CRITICAL progression is deterministic", () => {
    const steps: Array<[bigint, string]> = [
      [BigInt(50), "NORMAL"],
      [BigInt(100), "ELEVATED"],
      [BigInt(200), "HIGH"],
      [BigInt(400), "CRITICAL"],
    ];

    for (const [amount, expected] of steps) {
      clearVaultEvents(VAULT);
      recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount, timestamp: NOW - 500 });
      const { inflowPressure } = computePressureMetrics(VAULT, 1_000, NOW);
      expect(inflowPressure).toBe(expected);
    }
  });

  it("outflow pressure escalates independently of inflow", () => {
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(50), timestamp: NOW - 500 });
    recordFlowEvent({ vaultId: VAULT, direction: "outflow", amount: BigInt(400), timestamp: NOW - 500 });
    const m = computePressureMetrics(VAULT, 1_000, NOW);
    expect(m.inflowPressure).toBe("NORMAL");
    expect(m.outflowPressure).toBe("CRITICAL");
  });

  it("accumulated events within the window sum their velocities", () => {
    // Two events of 60 USDC each in 1 s → 120 USDC/s → ratio 120 → ELEVATED
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(60), timestamp: NOW - 800 });
    recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(60), timestamp: NOW - 400 });
    expect(computePressureMetrics(VAULT, 1_000, NOW).inflowPressure).toBe("ELEVATED");
  });
});

// ── Custom per-vault baseline calibration ─────────────────────────────────────

describe("custom per-vault baseline calibration", () => {
  const VAULT_A = "cal-vault-custom-a";
  const VAULT_B = "cal-vault-custom-b";

  afterEach(() => {
    clearVaultEvents(VAULT_A);
    clearVaultEvents(VAULT_B);
    clearVaultThresholds(VAULT_A);
    clearVaultThresholds(VAULT_B);
  });

  it("halved baseline (50 USDC/s) triggers ELEVATED at 50 USDC/s", () => {
    const halfBaseline: PressureThresholds = { ...DEFAULT_THRESHOLDS, baselineVelocity: 50 };
    // ratio = (50 / 50) * 100 = 100 ≥ elevatedBps(100) → ELEVATED
    expect(getPressureLevel(50, halfBaseline)).toBe("ELEVATED");
    // ratio = (49 / 50) * 100 = 98 < elevatedBps(100) → NORMAL
    expect(getPressureLevel(49, halfBaseline)).toBe("NORMAL");
  });

  it("halved baseline shifts CRITICAL boundary to 200 USDC/s", () => {
    const halfBaseline: PressureThresholds = { ...DEFAULT_THRESHOLDS, baselineVelocity: 50 };
    // ratio = (200 / 50) * 100 = 400 ≥ criticalBps(400) → CRITICAL
    expect(getPressureLevel(200, halfBaseline)).toBe("CRITICAL");
    // ratio = (199 / 50) * 100 = 398 < criticalBps(400) → HIGH
    expect(getPressureLevel(199, halfBaseline)).toBe("HIGH");
  });

  it("doubled baseline (200 USDC/s) keeps 150 USDC/s at NORMAL", () => {
    const doubleBaseline: PressureThresholds = { ...DEFAULT_THRESHOLDS, baselineVelocity: 200 };
    // ratio = (150 / 200) * 100 = 75 < elevatedBps(100) → NORMAL
    expect(getPressureLevel(150, doubleBaseline)).toBe("NORMAL");
  });

  it("same velocity produces different states across vaults with different baselines", () => {
    // Vault A has a conservative (low) baseline: small inflows look big
    setVaultThresholds(VAULT_A, { ...DEFAULT_THRESHOLDS, baselineVelocity: 50 });
    // Vault B has a generous (high) baseline: same inflow looks small
    setVaultThresholds(VAULT_B, { ...DEFAULT_THRESHOLDS, baselineVelocity: 400 });

    const SHARED_AMOUNT = BigInt(150);
    recordFlowEvent({ vaultId: VAULT_A, direction: "inflow", amount: SHARED_AMOUNT, timestamp: NOW - 500 });
    recordFlowEvent({ vaultId: VAULT_B, direction: "inflow", amount: SHARED_AMOUNT, timestamp: NOW - 500 });

    const mA = computePressureMetrics(VAULT_A, 1_000, NOW);
    const mB = computePressureMetrics(VAULT_B, 1_000, NOW);

    // VAULT_A: velocity 150, baseline 50 → ratio 300 → HIGH
    expect(mA.inflowPressure).toBe("HIGH");
    // VAULT_B: velocity 150, baseline 400 → ratio 37.5 → NORMAL
    expect(mB.inflowPressure).toBe("NORMAL");
  });

  it("custom thresholds only override specified fields; other fields keep defaults", () => {
    setVaultThresholds(VAULT_A, { baselineVelocity: 50 });
    // elevatedBps, highBps, criticalBps should remain at DEFAULT_THRESHOLDS values
    // ratio = (60 / 50) * 100 = 120 ≥ elevatedBps(100) → ELEVATED
    recordFlowEvent({ vaultId: VAULT_A, direction: "inflow", amount: BigInt(60), timestamp: NOW - 500 });
    expect(computePressureMetrics(VAULT_A, 1_000, NOW).inflowPressure).toBe("ELEVATED");
  });
});

// ── Deterministic output ──────────────────────────────────────────────────────

describe("deterministic output: same inputs always produce the same PressureLevel", () => {
  it("getPressureLevel is a pure function (no internal state)", () => {
    const inputs: Array<[number, string]> = [
      [0, "NORMAL"],
      [50, "NORMAL"],
      [99, "NORMAL"],
      [100, "ELEVATED"],
      [199, "ELEVATED"],
      [200, "HIGH"],
      [399, "HIGH"],
      [400, "CRITICAL"],
    ];

    // Run twice to confirm no state drift between calls
    for (let run = 0; run < 2; run++) {
      for (const [velocity, expected] of inputs) {
        expect(getPressureLevel(velocity)).toBe(expected);
      }
    }
  });

  it("event-based classification is deterministic for identical sequences", () => {
    const VAULT = "cal-vault-determ";

    const inject = () => {
      clearVaultEvents(VAULT);
      clearVaultThresholds(VAULT);
      recordFlowEvent({ vaultId: VAULT, direction: "inflow", amount: BigInt(250), timestamp: NOW - 500 });
      return computePressureMetrics(VAULT, 1_000, NOW).inflowPressure;
    };

    // Same event sequence must yield the same level on repeated calls
    expect(inject()).toBe("HIGH");
    expect(inject()).toBe("HIGH");
    expect(inject()).toBe("HIGH");
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("zero velocity is always NORMAL", () => {
    expect(getPressureLevel(0)).toBe("NORMAL");
    expect(getPressureLevel(0, DEFAULT_THRESHOLDS)).toBe("NORMAL");
  });

  it("zero baseline velocity produces NORMAL (safe division guard)", () => {
    const zeroBaseline: PressureThresholds = { ...DEFAULT_THRESHOLDS, baselineVelocity: 0 };
    // ratio = 0 (guard in classifyPressure) → NORMAL
    expect(getPressureLevel(9999, zeroBaseline)).toBe("NORMAL");
  });

  it("very high velocity does not overflow — stays at CRITICAL", () => {
    expect(getPressureLevel(Number.MAX_SAFE_INTEGER / 2)).toBe("CRITICAL");
  });

  it("vault with no events and default thresholds reports NORMAL for both directions", () => {
    const VAULT = "cal-vault-empty";
    clearVaultEvents(VAULT);
    clearVaultThresholds(VAULT);
    const m = computePressureMetrics(VAULT, DEFAULT_WINDOW_MS, NOW);
    expect(m.inflowPressure).toBe("NORMAL");
    expect(m.outflowPressure).toBe("NORMAL");
    expect(m.netVelocity).toBe(0);
  });
});
