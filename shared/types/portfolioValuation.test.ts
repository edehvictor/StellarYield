import { describe, it, expect } from "vitest";
import {
  resolveValuationPriceStatus,
  resolvePositionValuation,
  computePortfolioValuationSummary,
  validatePositionValuationInput,
  validatePortfolioValuationInputs,
  computeValidatedPortfolioValuationSummary,
  type PositionValuationInput,
} from "./portfolioValuation";

describe("portfolioValuation (#1660)", () => {
  describe("resolveValuationPriceStatus", () => {
    it("distinguishes genuine zero holdings from unpriced holdings", () => {
      // Genuine zero balance
      expect(resolveValuationPriceStatus(0, 0)).toBe("zero");

      // Positive deposited amount with null/undefined current value -> unpriced
      expect(resolveValuationPriceStatus(1000, null)).toBe("unpriced");
      expect(resolveValuationPriceStatus(1000, undefined)).toBe("unpriced");
      expect(resolveValuationPriceStatus(1000, NaN)).toBe("unpriced");

      // Positive deposited amount with known market value -> priced
      expect(resolveValuationPriceStatus(1000, 1050)).toBe("priced");
    });

    it("respects explicit isPriceUnavailable and priceStatus overrides", () => {
      expect(
        resolveValuationPriceStatus(1000, 1050, { isPriceUnavailable: true }),
      ).toBe("unpriced");

      expect(
        resolveValuationPriceStatus(1000, 1050, { priceStatus: "unpriced" }),
      ).toBe("unpriced");

      expect(
        resolveValuationPriceStatus(0, 0, { priceStatus: "zero" }),
      ).toBe("zero");
    });
  });

  describe("resolvePositionValuation", () => {
    it("resolves an unpriced position with null currentValue and null pnlUsd", () => {
      const input: PositionValuationInput = {
        protocol: "Blend",
        asset: "ORACLE_LESS",
        deposited: 2000,
        currentValue: null,
      };
      const resolved = resolvePositionValuation(input);
      expect(resolved.priceStatus).toBe("unpriced");
      expect(resolved.isUnpriced).toBe(true);
      expect(resolved.isPriced).toBe(false);
      expect(resolved.currentValue).toBeNull();
      expect(resolved.pnlUsd).toBeNull();
    });

    it("resolves a genuine zero balance with $0 current value and $0 pnl", () => {
      const input: PositionValuationInput = {
        protocol: "Soroswap",
        asset: "XLM",
        deposited: 0,
        currentValue: 0,
      };
      const resolved = resolvePositionValuation(input);
      expect(resolved.priceStatus).toBe("zero");
      expect(resolved.isZeroBalance).toBe(true);
      expect(resolved.currentValue).toBe(0);
      expect(resolved.pnlUsd).toBe(0);
    });

    it("resolves a priced position with active P&L", () => {
      const input: PositionValuationInput = {
        protocol: "Blend",
        asset: "USDC",
        deposited: 5000,
        currentValue: 5200,
      };
      const resolved = resolvePositionValuation(input);
      expect(resolved.priceStatus).toBe("priced");
      expect(resolved.isPriced).toBe(true);
      expect(resolved.currentValue).toBe(5200);
      expect(resolved.pnlUsd).toBe(200);
    });
  });

  describe("computePortfolioValuationSummary", () => {
    it("evaluates an empty portfolio", () => {
      const summary = computePortfolioValuationSummary([]);
      expect(summary.completeness).toBe("empty");
      expect(summary.isComplete).toBe(true);
      expect(summary.totalValueUsd).toBe(0);
      expect(summary.pricedValueUsd).toBe(0);
      expect(summary.yieldEarnedUsd).toBe(0);
      expect(summary.unpricedCount).toBe(0);
    });

    it("evaluates a fully priced portfolio", () => {
      const positions: PositionValuationInput[] = [
        { protocol: "Blend", asset: "USDC", deposited: 5000, currentValue: 5160 },
        { protocol: "Soroswap", asset: "XLM", deposited: 2000, currentValue: 2100 },
      ];
      const summary = computePortfolioValuationSummary(positions);
      expect(summary.completeness).toBe("complete");
      expect(summary.isComplete).toBe(true);
      expect(summary.totalValueUsd).toBe(7260);
      expect(summary.pricedValueUsd).toBe(7260);
      expect(summary.totalDepositedUsd).toBe(7000);
      expect(summary.pricedDepositedUsd).toBe(7000);
      expect(summary.yieldEarnedUsd).toBe(260);
      expect(summary.unpricedCount).toBe(0);
      expect(summary.unpricedAssets).toEqual([]);
    });

    it("evaluates mixed priced/unpriced holdings with partial completeness and fair yield calculation", () => {
      const positions: PositionValuationInput[] = [
        { protocol: "Blend", asset: "USDC", deposited: 5000, currentValue: 5150 },
        { protocol: "DeFindex", asset: "YIELD_INDEX", deposited: 3000, currentValue: null }, // unpriced!
        { protocol: "Soroswap", asset: "OLD_TOKEN", deposited: 0, currentValue: 0 }, // genuine zero
      ];
      const summary = computePortfolioValuationSummary(positions);

      expect(summary.completeness).toBe("partial");
      expect(summary.isComplete).toBe(false);
      expect(summary.unpricedCount).toBe(1);
      expect(summary.pricedCount).toBe(1);
      expect(summary.zeroCount).toBe(1);
      expect(summary.unpricedAssets).toEqual(["YIELD_INDEX"]);

      // Priced value should sum priced assets only
      expect(summary.pricedValueUsd).toBe(5150);
      expect(summary.totalValueUsd).toBe(5150);

      // Total deposited includes all assets ($8,000)
      expect(summary.totalDepositedUsd).toBe(8000);

      // BUT priced deposited is $5,000, so yield earned is +$150, NOT -$2,850!
      expect(summary.pricedDepositedUsd).toBe(5000);
      expect(summary.yieldEarnedUsd).toBe(150);
    });

    it("evaluates an all-unpriced portfolio", () => {
      const positions: PositionValuationInput[] = [
        { protocol: "DeFindex", asset: "ALPHA", deposited: 3000, currentValue: null },
        { protocol: "Blend", asset: "BETA", deposited: 4000, isPriceUnavailable: true },
      ];
      const summary = computePortfolioValuationSummary(positions);

      expect(summary.completeness).toBe("unavailable");
      expect(summary.isComplete).toBe(false);
      expect(summary.unpricedCount).toBe(2);
      expect(summary.pricedCount).toBe(0);
      expect(summary.totalValueUsd).toBeNull();
      expect(summary.yieldEarnedUsd).toBeNull();
      expect(summary.pricedValueUsd).toBe(0);
      expect(summary.totalDepositedUsd).toBe(7000);
      expect(summary.unpricedAssets).toEqual(["ALPHA", "BETA"]);
    });
  });

  describe("malformed external data boundary (#1865)", () => {
    it("validates a well-formed position without mutating the source object", () => {
      const input = {
        protocol: "Blend",
        asset: "USDC",
        deposited: 1000,
        currentValue: 1050,
        apy: 5,
        extra: "ignored",
      };
      const snapshot = JSON.parse(JSON.stringify(input));
      const result = validatePositionValuationInput(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          protocol: "Blend",
          asset: "USDC",
          deposited: 1000,
          currentValue: 1050,
          apy: 5,
        });
        expect(result.value).not.toBe(input);
      }
      expect(input).toEqual(snapshot);
    });

    it("returns a typed failure for each malformed field without throwing", () => {
      expect(validatePositionValuationInput(null).ok).toBe(false);
      expect(validatePositionValuationInput("nope").ok).toBe(false);
      expect(validatePositionValuationInput({ protocol: "", asset: "USDC" }).ok).toBe(false);
      expect(validatePositionValuationInput({ protocol: "Blend", asset: "USDC", deposited: NaN }).ok).toBe(false);
      expect(validatePositionValuationInput({ protocol: "Blend", asset: "USDC", currentValue: Infinity }).ok).toBe(false);
      expect(validatePositionValuationInput({ protocol: "Blend", asset: "USDC", deposited: -1 }).ok).toBe(false);

      const result = validatePositionValuationInput(
        { protocol: "Blend", asset: "USDC", priceStatus: "UNKNOWN" },
        2,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure).toEqual({
          code: "INVALID_FIELD",
          message: "Invalid priceStatus: must be priced, unpriced, or zero",
          field: "priceStatus",
          index: 2,
        });
      }
    });

    it("rejects malformed lists and never returns a partial summary", () => {
      expect(validatePortfolioValuationInputs({}).ok).toBe(false);

      const result = validatePortfolioValuationInputs([
        { protocol: "Blend", asset: "USDC", deposited: 100, currentValue: 110 },
        { protocol: "Blend", asset: "BAD", deposited: "200", currentValue: 210 },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("INVALID_FIELD");
        expect(result.failure.field).toBe("deposited");
        expect(result.failure.index).toBe(1);
      }

      const summaryResult = computeValidatedPortfolioValuationSummary([
        { protocol: "Blend", asset: "USDC", deposited: 100, currentValue: 110 },
        { protocol: "Blend", asset: "BAD", deposited: "200", currentValue: 210 },
      ]);
      expect(summaryResult.ok).toBe(false);
      if (summaryResult.ok) {
        throw new Error("expected a typed failure");
      }
      expect(summaryResult.failure.field).toBe("deposited");
    });

    it("supports safe retry after malformed data is replaced", () => {
      const bad = computeValidatedPortfolioValuationSummary([
        { protocol: "Blend", asset: "USDC", deposited: 100, currentValue: Number.NaN },
      ]);
      expect(bad.ok).toBe(false);

      const retry = computeValidatedPortfolioValuationSummary([
        { protocol: "Blend", asset: "USDC", deposited: 100, currentValue: 110 },
      ]);
      expect(retry.ok).toBe(true);
      if (retry.ok) {
        expect(retry.summary.totalValueUsd).toBe(110);
        expect(retry.summary.completeness).toBe("complete");
      }
    });
  });
});
