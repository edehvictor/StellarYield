import {
  PortfolioService,
  PortfolioValuationDataError,
  type VaultPosition,
} from "../services/portfolioService";

const validPositions: VaultPosition[] = [
  {
    protocol: "Blend",
    asset: "USDC",
    depositedUsd: 5000,
    currentValueUsd: 5200,
  },
  {
    protocol: "DeFindex",
    asset: "INDEX",
    depositedUsd: 3000,
    currentValueUsd: null,
  },
];

describe("PortfolioService valuation boundary (#1865)", () => {
  it("computes a complete summary for valid positions", () => {
    const result = PortfolioService.computeValidatedValuationSummary(validPositions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.completeness).toBe("partial");
      expect(result.summary.pricedValueUsd).toBe(5200);
      expect(result.summary.unpricedAssets).toEqual(["INDEX"]);
    }
  });

  it("returns a typed failure for malformed external fields without mutating input", () => {
    const snapshot = JSON.parse(JSON.stringify(validPositions));
    const malformed = [
      ...validPositions,
      { protocol: "Blend", asset: "BAD", depositedUsd: Number.POSITIVE_INFINITY, currentValueUsd: 10 },
    ];

    const result = PortfolioService.computeValidatedValuationSummary(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("INVALID_FIELD");
      expect(result.failure.field).toBe("deposited");
      expect(result.failure.index).toBe(2);
    }
    expect(malformed).toHaveLength(3);
    expect(validPositions).toEqual(snapshot);
  });

  it("throws a typed error from the legacy helper instead of emitting a partial summary", () => {
    expect(() =>
      PortfolioService.computeValuationSummary([
        { protocol: "Blend", asset: "USDC", depositedUsd: 100, currentValueUsd: NaN },
      ]),
    ).toThrow(PortfolioValuationDataError);

    try {
      PortfolioService.computeValuationSummary([
        { protocol: "Blend", asset: "USDC", depositedUsd: 100, currentValueUsd: NaN },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(PortfolioValuationDataError);
      if (error instanceof PortfolioValuationDataError) {
        expect(error.statusCode).toBe(400);
        expect(error.code).toBe("PORTFOLIO_VALUATION_INVALID_DATA");
        expect(error.details.field).toBe("currentValue");
      }
    }
  });

  it("supports safe retry after rejected data is replaced", () => {
    const rejected = PortfolioService.computeValidatedValuationSummary([
      { protocol: "Blend", asset: "USDC", depositedUsd: 100, currentValueUsd: NaN },
    ]);
    expect(rejected.ok).toBe(false);

    const retry = PortfolioService.computeValidatedValuationSummary([
      { protocol: "Blend", asset: "USDC", depositedUsd: 100, currentValueUsd: 110 },
    ]);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.summary.totalValueUsd).toBe(110);
    }
  });
});
