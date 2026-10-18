/**
 * Vault share redemption preview (#1404): the shared BigInt math and the route.
 */

import express from "express";
import fc from "fast-check";
import request from "supertest";

import redemptionPreviewRouter, { parseAmount, parsePercentToBps } from "../routes/vaultRedemptionPreview";
import {
  MAX_REDEMPTION_AMOUNT,
  RedemptionError,
  formatScaled,
  previewRedemption,
  type RedemptionInputs,
  type RedemptionRequest,
} from "../../../shared/types/vaultRedemption";

// A vault whose share price is 1.05 (1_050 assets per 1_000 shares).
const STATE = { totalAssets: 1_050_000_000n, totalShares: 1_000_000_000n };

const inputs = (request: RedemptionRequest, overrides: Partial<RedemptionInputs> = {}): RedemptionInputs => ({
  state: STATE,
  userShares: 100_000_000n,
  request,
  ...overrides,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RedemptionError) return error.code;
    throw error;
  }
  return undefined;
};

describe("previewRedemption — exact values", () => {
  it("redeems a partial number of shares at the current share price", () => {
    const preview = previewRedemption(inputs({ mode: "shares", shares: 40_000_000n }));

    expect(preview).toMatchObject({
      mode: "shares",
      sharesToBurn: 40_000_000n,
      grossAssets: 42_000_000n,
      exitFeeAssets: 0n,
      netAssets: 42_000_000n,
      remainingShares: 60_000_000n,
      remainingAssets: 63_000_000n,
      maxRedeemableAssets: 105_000_000n,
      sharePriceScaled: 10_500_000n,
      percentOfPositionBps: 4_000n,
      isFullRedemption: false,
      roundingDustAssets: 0n,
      warnings: [],
    });
  });

  it("redeems a percentage of the position", () => {
    const preview = previewRedemption(inputs({ mode: "percent", percentBps: 2_500n }));

    expect(preview.sharesToBurn).toBe(25_000_000n);
    expect(preview.remainingShares).toBe(75_000_000n);
    expect(preview.percentOfPositionBps).toBe(2_500n);
  });

  it("treats 100% as the whole position exactly", () => {
    const preview = previewRedemption(inputs({ mode: "percent", percentBps: 10_000n }, { userShares: 33n }));

    expect(preview.sharesToBurn).toBe(33n);
    expect(preview.remainingShares).toBe(0n);
    expect(preview.isFullRedemption).toBe(true);
  });

  it("rounds a percentage of the position down, never above what was asked", () => {
    // 33.33% of 100 shares = 33.33 -> 33.
    const preview = previewRedemption(
      inputs({ mode: "percent", percentBps: 3_333n }, { state: { totalAssets: 100n, totalShares: 100n }, userShares: 100n }),
    );

    expect(preview.sharesToBurn).toBe(33n);
  });

  describe("withdrawing an exact amount of assets", () => {
    it("burns the shares needed, rounding up in the vault's favour", () => {
      // 100 assets at 1.05 needs 95.238... shares -> 96.
      const preview = previewRedemption(inputs({ mode: "assets", assets: 100n }));

      expect(preview.sharesToBurn).toBe(96n);
      expect(preview.grossAssets).toBe(100n);
      // 96 shares are worth floor(96 * 1.05) = 100 assets; nothing extra kept.
      expect(preview.roundingDustAssets).toBe(0n);
    });

    it("reports the value of the burned shares that exceeds the request as rounding dust", () => {
      const state = { totalAssets: 1_000n, totalShares: 300n }; // 3.333.. assets/share
      const preview = previewRedemption(inputs({ mode: "assets", assets: 10n }, { state, userShares: 300n }));

      // ceil(10 * 300 / 1000) = 3 shares, worth floor(3 * 1000 / 300) = 10.
      expect(preview.sharesToBurn).toBe(3n);
      expect(preview.roundingDustAssets).toBe(0n);

      const odd = previewRedemption(inputs({ mode: "assets", assets: 7n }, { state, userShares: 300n }));
      // ceil(7 * 300 / 1000) = ceil(2.1) = 3 shares, worth 10 -> 3 assets of dust.
      expect(odd.sharesToBurn).toBe(3n);
      expect(odd.roundingDustAssets).toBe(3n);
    });

    it("can withdraw a position's full value", () => {
      const preview = previewRedemption(inputs({ mode: "assets", assets: 105_000_000n }));

      expect(preview.sharesToBurn).toBe(100_000_000n);
      expect(preview.isFullRedemption).toBe(true);
    });
  });

  describe("exit fee", () => {
    it("deducts the fee from the gross assets, rounding the fee down", () => {
      const preview = previewRedemption(inputs({ mode: "shares", shares: 40_000_000n }, { exitFeeBps: 30n }));

      expect(preview.grossAssets).toBe(42_000_000n);
      expect(preview.exitFeeAssets).toBe(126_000n); // 0.30% of 42,000,000
      expect(preview.netAssets).toBe(41_874_000n);
    });

    it("floors a fee smaller than one unit to zero", () => {
      const preview = previewRedemption(
        inputs({ mode: "shares", shares: 1n }, { state: { totalAssets: 100n, totalShares: 100n }, userShares: 5n, exitFeeBps: 50n }),
      );

      expect(preview.exitFeeAssets).toBe(0n);
      expect(preview.netAssets).toBe(1n);
    });

    it("allows a 100% fee", () => {
      const preview = previewRedemption(inputs({ mode: "shares", shares: 1_000n }, { exitFeeBps: 10_000n }));

      expect(preview.netAssets).toBe(0n);
      expect(preview.exitFeeAssets).toBe(preview.grossAssets);
    });
  });

  describe("share price", () => {
    it("is reported per share with the requested precision", () => {
      const preview = previewRedemption(inputs({ mode: "shares", shares: 1_000n }));

      expect(formatScaled(preview.sharePriceScaled, 7)).toBe("1.0500000");
    });

    it("reflects a vault that has lost value", () => {
      const state = { totalAssets: 900n, totalShares: 1_000n };
      const preview = previewRedemption(inputs({ mode: "shares", shares: 100n }, { state, userShares: 500n }));

      expect(formatScaled(preview.sharePriceScaled, 7)).toBe("0.9000000");
      expect(preview.grossAssets).toBe(90n);
    });
  });

  describe("warnings", () => {
    it("warns when a partial redemption leaves a remainder below the minimum position", () => {
      const preview = previewRedemption(
        inputs({ mode: "shares", shares: 99_999_000n }, { minRemainingShares: 10_000n }),
      );

      expect(preview.remainingShares).toBe(1_000n);
      expect(preview.warnings.map((w) => w.code)).toEqual(["DUST_REMAINDER"]);
    });

    it("does not warn about dust for a full redemption or when the remainder is large enough", () => {
      expect(
        previewRedemption(inputs({ mode: "percent", percentBps: 10_000n }, { minRemainingShares: 10_000n })).warnings,
      ).toEqual([]);
      expect(
        previewRedemption(inputs({ mode: "shares", shares: 50_000_000n }, { minRemainingShares: 10_000n })).warnings,
      ).toEqual([]);
    });

    it("warns when the remainder is worth nothing on its own", () => {
      const state = { totalAssets: 10n, totalShares: 1_000n }; // 0.01 assets per share
      const preview = previewRedemption(inputs({ mode: "shares", shares: 900n }, { state, userShares: 950n }));

      expect(preview.remainingAssets).toBe(0n);
      expect(preview.warnings.map((w) => w.code)).toContain("REMAINDER_WORTHLESS");
    });
  });

  describe("errors", () => {
    it.each([
      ["more shares than owned", { mode: "shares", shares: 100_000_001n } as RedemptionRequest, "INSUFFICIENT_SHARES"],
      ["more assets than the position is worth", { mode: "assets", assets: 105_000_001n } as RedemptionRequest, "INSUFFICIENT_SHARES"],
      ["zero shares", { mode: "shares", shares: 0n } as RedemptionRequest, "INVALID_AMOUNT"],
      ["negative shares", { mode: "shares", shares: -1n } as RedemptionRequest, "INVALID_AMOUNT"],
      ["zero assets", { mode: "assets", assets: 0n } as RedemptionRequest, "INVALID_AMOUNT"],
      ["0%", { mode: "percent", percentBps: 0n } as RedemptionRequest, "INVALID_PERCENT"],
      ["over 100%", { mode: "percent", percentBps: 10_001n } as RedemptionRequest, "INVALID_PERCENT"],
    ])("rejects %s", (_label, request, code) => {
      expect(codeOf(() => previewRedemption(inputs(request)))).toBe(code);
    });

    it("says how much could be redeemed when the request is too large", () => {
      try {
        previewRedemption(inputs({ mode: "shares", shares: 200_000_000n }));
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(RedemptionError);
        expect((error as RedemptionError).details).toEqual({ maxShares: "100000000", maxAssets: "105000000" });
      }
    });

    it("reports a user with no shares as insufficient, whatever the mode", () => {
      for (const request of [
        { mode: "shares", shares: 1n },
        { mode: "percent", percentBps: 5_000n },
      ] as RedemptionRequest[]) {
        expect(codeOf(() => previewRedemption(inputs(request, { userShares: 0n })))).toBe("INSUFFICIENT_SHARES");
      }
    });

    it("rejects a redemption worth less than one unit of the asset", () => {
      const state = { totalAssets: 10n, totalShares: 1_000n };

      expect(codeOf(() => previewRedemption(inputs({ mode: "shares", shares: 50n }, { state, userShares: 100n })))).toBe(
        "REDEMPTION_TOO_SMALL",
      );
    });

    it("rejects a 1% slice of a tiny position that rounds to zero shares", () => {
      expect(
        codeOf(() => previewRedemption(inputs({ mode: "percent", percentBps: 100n }, { userShares: 50n }))),
      ).toBe("REDEMPTION_TOO_SMALL");
    });

    it.each([
      ["no shares outstanding", { totalAssets: 100n, totalShares: 0n }],
      ["no assets", { totalAssets: 0n, totalShares: 100n }],
    ])("rejects a vault with %s as empty", (_label, state) => {
      expect(codeOf(() => previewRedemption(inputs({ mode: "shares", shares: 1n }, { state, userShares: 0n })))).toBe(
        "VAULT_EMPTY",
      );
    });

    it.each([
      ["a share balance above the total shares", { userShares: 2_000_000_000n }],
      ["a negative share balance", { userShares: -1n }],
      ["a negative total", { state: { totalAssets: -1n, totalShares: 10n } }],
      ["a total above the i128 maximum", { state: { totalAssets: MAX_REDEMPTION_AMOUNT + 1n, totalShares: 10n } }],
    ])("rejects %s", (_label, overrides) => {
      expect(codeOf(() => previewRedemption(inputs({ mode: "shares", shares: 1n }, overrides)))).toBe("INVALID_VAULT_STATE");
    });

    it.each([[-1n], [10_001n]])("rejects the exit fee %p", (exitFeeBps) => {
      expect(codeOf(() => previewRedemption(inputs({ mode: "shares", shares: 1_000n }, { exitFeeBps })))).toBe("INVALID_FEE_BPS");
    });
  });

  it("handles amounts far beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const huge = 10n ** 30n;
    const preview = previewRedemption({
      state: { totalAssets: huge * 2n, totalShares: huge },
      userShares: huge / 2n,
      request: { mode: "percent", percentBps: 5_000n },
    });

    expect(preview.sharesToBurn).toBe(huge / 4n);
    expect(preview.grossAssets).toBe(huge / 2n);
  });
});

describe("previewRedemption — properties", () => {
  const amount = fc.bigInt({ min: 1n, max: 10n ** 24n });

  // A vault and a holder: userShares <= totalShares, both positive.
  const scenario = fc
    .record({ totalShares: amount, totalAssets: amount, fraction: fc.integer({ min: 1, max: 10_000 }) })
    .map(({ totalShares, totalAssets, fraction }) => ({
      state: { totalAssets, totalShares },
      userShares: (totalShares * BigInt(fraction)) / 10_000n || 1n,
    }));

  it("burned shares plus remaining shares always equal the position", () => {
    fc.assert(
      fc.property(scenario, fc.integer({ min: 1, max: 10_000 }), ({ state, userShares }, bps) => {
        try {
          const p = previewRedemption({ state, userShares, request: { mode: "percent", percentBps: BigInt(bps) } });
          expect(p.sharesToBurn + p.remainingShares).toBe(userShares);
          expect(p.sharesToBurn).toBeGreaterThan(0n);
        } catch (error) {
          if (!(error instanceof RedemptionError)) throw error;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never pays out more than the shares are worth (floor)", () => {
    fc.assert(
      fc.property(scenario, ({ state, userShares }) => {
        try {
          const p = previewRedemption({ state, userShares, request: { mode: "shares", shares: userShares } });
          // gross * totalShares <= shares * totalAssets  (i.e. gross <= exact value)
          expect(p.grossAssets * state.totalShares).toBeLessThanOrEqual(userShares * state.totalAssets);
          // ...and by less than one unit.
          expect((p.grossAssets + 1n) * state.totalShares).toBeGreaterThan(userShares * state.totalAssets);
        } catch (error) {
          if (!(error instanceof RedemptionError)) throw error;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("withdrawing an exact asset amount burns just enough shares, and one fewer would not cover it", () => {
    fc.assert(
      fc.property(scenario, fc.integer({ min: 1, max: 10_000 }), ({ state, userShares }, bps) => {
        const assets = (userShares * state.totalAssets * BigInt(bps)) / (state.totalShares * 10_000n);
        if (assets <= 0n) return;
        try {
          const p = previewRedemption({ state, userShares, request: { mode: "assets", assets } });
          const value = (s: bigint) => (s * state.totalAssets) / state.totalShares;
          expect(value(p.sharesToBurn)).toBeGreaterThanOrEqual(assets);
          expect(value(p.sharesToBurn - 1n)).toBeLessThan(assets);
          expect(p.roundingDustAssets).toBe(value(p.sharesToBurn) - assets);
        } catch (error) {
          if (!(error instanceof RedemptionError)) throw error;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("net plus fee equals gross and nothing is negative", () => {
    fc.assert(
      fc.property(scenario, fc.integer({ min: 0, max: 10_000 }), ({ state, userShares }, feeBps) => {
        try {
          const p = previewRedemption({
            state,
            userShares,
            request: { mode: "shares", shares: userShares },
            exitFeeBps: BigInt(feeBps),
          });
          expect(p.netAssets + p.exitFeeAssets).toBe(p.grossAssets);
          for (const v of [p.netAssets, p.exitFeeAssets, p.remainingAssets, p.remainingShares, p.sharePriceScaled]) {
            expect(v).toBeGreaterThanOrEqual(0n);
          }
        } catch (error) {
          if (!(error instanceof RedemptionError)) throw error;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("redeeming more shares never pays less", () => {
    fc.assert(
      fc.property(scenario, ({ state, userShares }) => {
        if (userShares < 2n) return;
        try {
          const half = previewRedemption({ state, userShares, request: { mode: "shares", shares: userShares / 2n } });
          const all = previewRedemption({ state, userShares, request: { mode: "shares", shares: userShares } });
          expect(all.grossAssets).toBeGreaterThanOrEqual(half.grossAssets);
        } catch (error) {
          if (!(error instanceof RedemptionError)) throw error;
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("parseAmount / parsePercentToBps", () => {
  it.each([
    [0, 0n],
    [42, 42n],
    ["0", 0n],
    ["123456789012345678901234567890", 123456789012345678901234567890n],
    [String(MAX_REDEMPTION_AMOUNT), MAX_REDEMPTION_AMOUNT],
  ])("parses %p", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "-1", "1.5", "1e3", " 5", "", "abc", null, undefined, true, {}, [], String(MAX_REDEMPTION_AMOUNT + 1n), "9".repeat(40)])(
    "rejects %p",
    (input) => {
      expect(parseAmount(input)).toBeNull();
    },
  );

  it.each([
    [25, 2_500n],
    ["25", 2_500n],
    ["33.33", 3_333n],
    ["0.01", 1n],
    ["100", 10_000n],
    ["100.00", 10_000n],
    [12.5, 1_250n],
  ])("converts %p%% to %p bps", (input, bps) => {
    expect(parsePercentToBps(input)).toBe(bps);
  });

  it.each([0, "0", "0.00", -5, 100.01, 101, "1.234", "abc", "", NaN, null, undefined, {}])("rejects the percentage %p", (input) => {
    expect(parsePercentToBps(input)).toBeNull();
  });
});

describe("POST /api/vaults/:vaultId/redemption-preview", () => {
  const app = express().use(express.json()).use("/api/vaults", redemptionPreviewRouter);

  const state = { totalAssets: "1050000000", totalShares: "1000000000", userShares: "100000000" };
  const post = (body: Record<string, unknown>) => request(app).post("/api/vaults/blend-stable/redemption-preview").send(body);

  it("previews a partial redemption of shares", async () => {
    const res = await post({ ...state, shares: "40000000" }).expect(200);

    expect(res.body).toMatchObject({
      vaultId: "blend-stable",
      mode: "shares",
      sharesToBurn: "40000000",
      grossAssets: "42000000",
      exitFeeBps: 0,
      exitFeeAssets: "0",
      netAssets: "42000000",
      remainingShares: "60000000",
      remainingAssets: "63000000",
      maxRedeemableAssets: "105000000",
      sharePrice: "1.0500000",
      percentOfPosition: 40,
      isFullRedemption: false,
      roundingDustAssets: "0",
      warnings: [],
      quoteTtlMs: 60_000,
    });
  });

  it("stamps a quote that expires after the shared withdrawal-quote TTL", async () => {
    const res = await post({ ...state, shares: 1000 }).expect(200);

    const ttl = Date.parse(res.body.expiresAt) - Date.parse(res.body.quotedAt);
    expect(ttl).toBe(60_000);
  });

  it("previews a percentage of the position", async () => {
    const res = await post({ ...state, percentOfPosition: 25 }).expect(200);

    expect(res.body).toMatchObject({ mode: "percent", sharesToBurn: "25000000", percentOfPosition: 25 });
  });

  it("previews withdrawing an exact asset amount", async () => {
    const res = await post({ ...state, assets: "100" }).expect(200);

    expect(res.body).toMatchObject({ mode: "assets", sharesToBurn: "96", grossAssets: "100" });
  });

  it("applies the exit fee and the dust threshold", async () => {
    const res = await post({ ...state, shares: "99999000", exitFeeBps: 100, minRemainingShares: "10000" }).expect(200);

    expect(res.body.exitFeeBps).toBe(100);
    expect(BigInt(res.body.netAssets) + BigInt(res.body.exitFeeAssets)).toBe(BigInt(res.body.grossAssets));
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toEqual(["DUST_REMAINDER"]);
  });

  it("keeps full precision for amounts beyond a JSON number's safe range", async () => {
    const huge = "100000000000000000000000000000"; // 1e29
    const res = await post({ totalAssets: huge, totalShares: huge, userShares: huge, shares: "33333333333333333333333333333" }).expect(200);

    expect(res.body.sharesToBurn).toBe("33333333333333333333333333333");
    expect(res.body.remainingShares).toBe("66666666666666666666666666667");
    expect(res.body.grossAssets).toBe("33333333333333333333333333333");
  });

  it("reports a whole-position redemption as full", async () => {
    const res = await post({ ...state, percentOfPosition: 100 }).expect(200);

    expect(res.body).toMatchObject({ isFullRedemption: true, remainingShares: "0", remainingAssets: "0" });
  });

  it.each([
    ["a missing vault total", { userShares: "1", totalShares: "1", shares: "1" }, "INVALID_VAULT_STATE", "totalAssets"],
    ["a fractional total", { ...state, totalAssets: "1.5", shares: "1" }, "INVALID_VAULT_STATE", "totalAssets"],
    ["a negative balance", { ...state, userShares: -5, shares: "1" }, "INVALID_VAULT_STATE", "userShares"],
    ["an unsafe numeric amount", { ...state, userShares: Number.MAX_SAFE_INTEGER + 1, shares: "1" }, "INVALID_VAULT_STATE", "userShares"],
    ["a fractional amount", { ...state, shares: 1.5 }, "INVALID_AMOUNT", "shares"],
    ["a negative amount", { ...state, assets: "-3" }, "INVALID_AMOUNT", "assets"],
    ["an out-of-range percentage", { ...state, percentOfPosition: 120 }, "INVALID_PERCENT", "percentOfPosition"],
    ["a three-decimal percentage", { ...state, percentOfPosition: "10.123" }, "INVALID_PERCENT", "percentOfPosition"],
    ["a bad fee", { ...state, shares: "1", exitFeeBps: 10_001 }, "INVALID_FEE_BPS", "exitFeeBps"],
    ["a bad dust threshold", { ...state, shares: "1", minRemainingShares: -1 }, "INVALID_MIN_REMAINING", "minRemainingShares"],
  ])("answers 400 for %s", async (_label, body, code, field) => {
    const res = await post(body as Record<string, unknown>).expect(400);

    expect(res.body).toMatchObject({ error: code, details: { field } });
    expect(typeof res.body.message).toBe("string");
  });

  it.each([
    ["none of shares, assets and percentOfPosition", {}],
    ["two of them", { shares: "1", assets: "1" }],
    ["all three", { shares: "1", assets: "1", percentOfPosition: 5 }],
  ])("answers 400 when given %s", async (_label, extra) => {
    const res = await post({ ...state, ...extra }).expect(400);

    expect(res.body.error).toBe("INVALID_REQUEST");
  });

  it("answers 400 with the maximum when the request exceeds the position", async () => {
    const res = await post({ ...state, shares: "100000001" }).expect(400);

    expect(res.body).toMatchObject({
      error: "INSUFFICIENT_SHARES",
      details: { maxShares: "100000000", maxAssets: "105000000" },
    });
  });

  it("answers 400 for a redemption too small to pay out anything", async () => {
    const res = await post({ totalAssets: "10", totalShares: "1000", userShares: "100", shares: "50" }).expect(400);

    expect(res.body.error).toBe("REDEMPTION_TOO_SMALL");
  });

  it("answers 409 for an empty vault", async () => {
    const res = await post({ totalAssets: "0", totalShares: "0", userShares: "0", shares: "1" }).expect(409);

    expect(res.body.error).toBe("VAULT_EMPTY");
  });

  it("answers 400 for a missing body", async () => {
    await request(app).post("/api/vaults/blend-stable/redemption-preview").expect(400);
  });

  it("never leaks a stack trace or internal error", async () => {
    const res = await post({ ...state, shares: "100000001" }).expect(400);

    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|node_modules|RedemptionError/);
  });
});
