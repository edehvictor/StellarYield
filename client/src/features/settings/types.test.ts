import { describe, it, expect } from "vitest";
import {
  resolveSlippage,
  resolveDeadlineSeconds,
  DEFAULT_TX_SETTINGS,
  SLIPPAGE_MIN,
  SLIPPAGE_MAX,
  DEADLINE_MIN,
  DEADLINE_MAX,
} from "./types";
import type { TxSettings } from "./types";

describe("resolveSlippage", () => {
  it("returns 0.5 in auto mode regardless of customSlippagePct", () => {
    const s: TxSettings = { ...DEFAULT_TX_SETTINGS, slippageMode: "auto", customSlippagePct: 2.0 };
    expect(resolveSlippage(s)).toBe(0.5);
  });

  it("returns customSlippagePct in custom mode", () => {
    const s: TxSettings = { ...DEFAULT_TX_SETTINGS, slippageMode: "custom", customSlippagePct: 1.5 };
    expect(resolveSlippage(s)).toBe(1.5);
  });

  it("clamps custom slippage to SLIPPAGE_MIN", () => {
    const s: TxSettings = { ...DEFAULT_TX_SETTINGS, slippageMode: "custom", customSlippagePct: -1 };
    expect(resolveSlippage(s)).toBe(SLIPPAGE_MIN);
  });

  it("clamps custom slippage to SLIPPAGE_MAX", () => {
    const s: TxSettings = { ...DEFAULT_TX_SETTINGS, slippageMode: "custom", customSlippagePct: 99 };
    expect(resolveSlippage(s)).toBe(SLIPPAGE_MAX);
  });

  it("returns exactly SLIPPAGE_MAX when set to SLIPPAGE_MAX", () => {
    const s: TxSettings = { ...DEFAULT_TX_SETTINGS, slippageMode: "custom", customSlippagePct: SLIPPAGE_MAX };
    expect(resolveSlippage(s)).toBe(SLIPPAGE_MAX);
  });
});

describe("resolveDeadlineSeconds", () => {
  it("converts minutes to seconds", () => {
    const s: TxSettings = { ...DEFAULT_TX_SETTINGS, deadlineMinutes: 10 };
    expect(resolveDeadlineSeconds(s)).toBe(600);
  });

  it("clamps to DEADLINE_MIN", () => {
    const s: TxSettings = { ...DEFAULT_TX_SETTINGS, deadlineMinutes: 0 };
    expect(resolveDeadlineSeconds(s)).toBe(DEADLINE_MIN * 60);
  });

  it("clamps to DEADLINE_MAX", () => {
    const s: TxSettings = { ...DEFAULT_TX_SETTINGS, deadlineMinutes: 999 };
    expect(resolveDeadlineSeconds(s)).toBe(DEADLINE_MAX * 60);
  });

  it("uses default deadline from DEFAULT_TX_SETTINGS", () => {
    expect(resolveDeadlineSeconds(DEFAULT_TX_SETTINGS)).toBe(DEFAULT_TX_SETTINGS.deadlineMinutes * 60);
  });
});

describe("constants", () => {
  it("SLIPPAGE_MIN is less than SLIPPAGE_MAX", () => {
    expect(SLIPPAGE_MIN).toBeLessThan(SLIPPAGE_MAX);
  });

  it("DEADLINE_MIN is less than DEADLINE_MAX", () => {
    expect(DEADLINE_MIN).toBeLessThan(DEADLINE_MAX);
  });

  it("DEFAULT_TX_SETTINGS has auto mode", () => {
    expect(DEFAULT_TX_SETTINGS.slippageMode).toBe("auto");
  });

  it("DEFAULT_TX_SETTINGS deadline is within bounds", () => {
    expect(DEFAULT_TX_SETTINGS.deadlineMinutes).toBeGreaterThanOrEqual(DEADLINE_MIN);
    expect(DEFAULT_TX_SETTINGS.deadlineMinutes).toBeLessThanOrEqual(DEADLINE_MAX);
  });
});
