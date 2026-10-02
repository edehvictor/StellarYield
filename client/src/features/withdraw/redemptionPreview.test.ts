import { describe, expect, it } from "vitest";
import {
  PARTIAL_WITHDRAWAL_PRESETS,
  buildRedemptionView,
  formatPercentFromBps,
  sharesForPreset,
} from "./redemptionPreview";

const TOTALS = { totalAssets: 1_050_000_000n, totalShares: 1_000_000_000n };

describe("sharesForPreset", () => {
  it.each([
    [1_000n, 25, 250n],
    [1_000n, 50, 500n],
    [1_000n, 75, 750n],
    [1_000n, 100, 1_000n],
  ])("takes %p shares at %p%% as %p", (balance, percent, expected) => {
    expect(sharesForPreset(balance, percent)).toBe(expected);
  });

  it("rounds a partial portion down", () => {
    expect(sharesForPreset(101n, 25)).toBe(25n);
    expect(sharesForPreset(3n, 50)).toBe(1n);
  });

  it("returns the whole balance for 100%, even when it is not divisible", () => {
    expect(sharesForPreset(7n, 100)).toBe(7n);
  });

  it("never exceeds the balance, even for an oversized percent", () => {
    expect(sharesForPreset(7n, 250)).toBe(7n);
  });

  it.each([0n, -5n])("returns 0 for a balance of %p", (balance) => {
    expect(sharesForPreset(balance, 50)).toBe(0n);
  });

  it.each([0, -10, 12.5, NaN])("returns 0 for the invalid percent %p", (percent) => {
    expect(sharesForPreset(1_000n, percent)).toBe(0n);
  });

  it("handles balances beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(sharesForPreset(10n ** 30n, 25)).toBe(25n * 10n ** 28n);
  });

  it("offers 25, 50, 75 and 100 percent", () => {
    expect([...PARTIAL_WITHDRAWAL_PRESETS]).toEqual([25, 50, 75, 100]);
  });
});

describe("buildRedemptionView", () => {
  it("previews a partial redemption", () => {
    const view = buildRedemptionView({ totals: TOTALS, userShares: 100_000_000n, shares: 40_000_000n });

    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.sharePrice).toBe("1.0500000");
    expect(view.preview).toMatchObject({
      sharesToBurn: 40_000_000n,
      netAssets: 42_000_000n,
      remainingShares: 60_000_000n,
      remainingAssets: 63_000_000n,
      isFullRedemption: false,
    });
  });

  it("marks redeeming the whole balance as a full redemption", () => {
    const view = buildRedemptionView({ totals: TOTALS, userShares: 100n, shares: 100n });

    expect(view.ok && view.preview.isFullRedemption).toBe(true);
  });

  it("reports the most that could be redeemed when the amount exceeds the balance", () => {
    const view = buildRedemptionView({ totals: TOTALS, userShares: 100_000_000n, shares: 200_000_000n });

    expect(view).toMatchObject({
      ok: false,
      code: "INSUFFICIENT_SHARES",
      maxShares: 100_000_000n,
      maxAssets: 105_000_000n,
    });
  });

  it.each([
    ["an empty vault", { totalAssets: 0n, totalShares: 0n }, 0n, "VAULT_EMPTY"],
    ["a share balance above the total", { totalAssets: 10n, totalShares: 5n }, 10n, "INVALID_VAULT_STATE"],
  ])("returns a presentable error for %s", (_label, totals, userShares, code) => {
    const view = buildRedemptionView({ totals, userShares, shares: 1n });

    expect(view).toMatchObject({ ok: false, code });
    expect(view.ok ? "" : view.message).not.toMatch(/RedemptionError|at .*\.ts/);
  });

  it("returns a presentable error for an amount worth less than one unit", () => {
    const view = buildRedemptionView({
      totals: { totalAssets: 10n, totalShares: 1_000n },
      userShares: 100n,
      shares: 50n,
    });

    expect(view).toMatchObject({ ok: false, code: "REDEMPTION_TOO_SMALL" });
  });

  it("passes the dust threshold through as a warning", () => {
    const view = buildRedemptionView({
      totals: TOTALS,
      userShares: 100_000n,
      shares: 99_900n,
      minRemainingShares: 1_000n,
    });

    expect(view.ok && view.preview.warnings.map((w) => w.code)).toEqual(["DUST_REMAINDER"]);
  });
});

describe("formatPercentFromBps", () => {
  it.each([
    [2_500n, "25"],
    [3_333n, "33.33"],
    [1_250n, "12.5"],
    [1n, "0.01"],
    [10_000n, "100"],
    [0n, "0"],
  ])("formats %p bps as %p", (bps, expected) => {
    expect(formatPercentFromBps(bps)).toBe(expected);
  });
});
