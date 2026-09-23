/**
 * Tests for watchlist APY-drop alert helpers (#1295).
 * Covers the new apy_drop_pct rule type, baseline computation, formatting, and
 * edge cases where a drop is not computable.
 */

import { describe, it, expect } from "vitest";
import {
  computeApyDropPct,
  checkThresholdTrigger,
  formatThresholdRule,
  generateAlertMessage,
  type ThresholdRule,
} from "../watchlist";

const dropRule = (value: number, triggerOnce = false): ThresholdRule => ({
  id: "rule-drop",
  type: "apy_drop_pct",
  value,
  triggerOnce,
});

describe("computeApyDropPct", () => {
  it("computes the percentage drop from baseline", () => {
    expect(computeApyDropPct(10, 8)).toBeCloseTo(20, 5);
  });

  it("returns 0 when the current APY is above baseline", () => {
    expect(computeApyDropPct(8, 10)).toBe(0);
  });

  it("returns null when baseline is missing or zero", () => {
    expect(computeApyDropPct(undefined, 8)).toBeNull();
    expect(computeApyDropPct(0, 8)).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(computeApyDropPct(10, Number.NaN)).toBeNull();
    expect(computeApyDropPct(Number.POSITIVE_INFINITY, 8)).toBeNull();
  });
});

describe("checkThresholdTrigger (apy_drop_pct)", () => {
  it("triggers when the drop meets the threshold", () => {
    expect(checkThresholdTrigger(dropRule(20), 8, 0, 0, 10)).toBe(true);
  });

  it("does not trigger when the drop is below the threshold", () => {
    expect(checkThresholdTrigger(dropRule(30), 8, 0, 0, 10)).toBe(false);
  });

  it("does not trigger when the APY rose above baseline", () => {
    expect(checkThresholdTrigger(dropRule(10), 12, 0, 0, 10)).toBe(false);
  });

  it("never triggers without a baseline", () => {
    expect(checkThresholdTrigger(dropRule(10), 8, 0, 0, undefined)).toBe(false);
  });

  it("leaves existing rule types unchanged", () => {
    expect(
      checkThresholdTrigger({ id: "r", type: "apy_below", value: 9 }, 8, 0, 0, 10),
    ).toBe(true);
  });
});

describe("formatThresholdRule", () => {
  it("labels the drop rule in percentage points", () => {
    expect(formatThresholdRule(dropRule(15))).toBe("APY drop 15.00pp");
  });
});

describe("generateAlertMessage", () => {
  it("reports the computed drop and current APY", () => {
    const message = generateAlertMessage("Blend Vault", dropRule(20), 8, undefined, undefined, 10);
    expect(message).toContain("Blend Vault");
    expect(message).toContain("dropped 20.00%");
    expect(message).toContain("from baseline to 8.00%");
    expect(message).toContain("20.00% drop threshold");
  });
});