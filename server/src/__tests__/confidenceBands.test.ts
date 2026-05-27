import {
  calculateBandWidth,
  computeAllocationBands,
  getBandColor,
  formatAllocationBand,
} from "../services/confidenceService";

describe("calculateBandWidth", () => {
  it("should calculate narrower band for high confidence", () => {
    const highConfidenceWidth = calculateBandWidth(0.90, 0.10);
    const lowConfidenceWidth = calculateBandWidth(0.30, 0.10);

    expect(highConfidenceWidth).toBeLessThan(lowConfidenceWidth);
  });

  it("should calculate wider band for high volatility", () => {
    const lowVolWidth = calculateBandWidth(0.80, 0.10);
    const highVolWidth = calculateBandWidth(0.80, 0.50);

    expect(highVolWidth).toBeGreaterThan(lowVolWidth);
  });

  it("should use default base width when not specified", () => {
    const width = calculateBandWidth(0.80, 0.20);
    expect(width).toBeGreaterThan(0);
  });

  it("should return positive width", () => {
    const width = calculateBandWidth(0.85, 0.15);
    expect(width).toBeGreaterThan(0);
  });

  it("should handle edge case of perfect confidence", () => {
    const width = calculateBandWidth(1.0, 0.0);
    expect(width).toBeGreaterThanOrEqual(5.0); // Base width
  });

  it("should handle edge case of zero confidence", () => {
    const width = calculateBandWidth(0.0, 0.50);
    expect(width).toBeGreaterThan(5.0); // Should be wider than base
  });

  it("should cap volatility factor at 1.0", () => {
    const width1 = calculateBandWidth(0.80, 0.50);
    const width2 = calculateBandWidth(0.80, 1.0);
    
    // Both should be similar since volatility is capped
    expect(width1).toBeCloseTo(width2, 2);
  });
});

describe("computeAllocationBands", () => {
  const sampleAllocations = [
    {
      assetId: "USDC",
      recommendedAllocation: 40.0,
      confidenceScore: 0.90,
      volatility: 0.02,
    },
    {
      assetId: "ETH",
      recommendedAllocation: 35.0,
      confidenceScore: 0.75,
      volatility: 0.15,
    },
    {
      assetId: "BTC",
      recommendedAllocation: 25.0,
      confidenceScore: 0.80,
      volatility: 0.12,
    },
  ];

  it("should compute bands for all allocations", () => {
    const result = computeAllocationBands(sampleAllocations);

    expect(result.bands).toHaveLength(3);
    expect(result.bands[0].assetId).toBe("USDC");
    expect(result.bands[1].assetId).toBe("ETH");
    expect(result.bands[2].assetId).toBe("BTC");
  });

  it("should calculate correct total allocation", () => {
    const result = computeAllocationBands(sampleAllocations);

    expect(result.totalAllocation).toBe(100.0);
  });

  it("should calculate portfolio confidence as average", () => {
    const result = computeAllocationBands(sampleAllocations);
    const expectedConfidence = (0.90 + 0.75 + 0.80) / 3;

    expect(result.portfolioConfidence).toBeCloseTo(expectedConfidence, 3);
  });

  it("should include disclaimer in each band", () => {
    const result = computeAllocationBands(sampleAllocations);

    result.bands.forEach((band) => {
      expect(band.disclaimer).toContain("uncertainty");
      expect(band.disclaimer).toContain("guaranteed");
    });
  });

  it("should include interpretation in result", () => {
    const result = computeAllocationBands(sampleAllocations);

    expect(result.interpretation).toContain("Wider bands");
    expect(result.interpretation).toContain("uncertainty");
  });

  it("should calculate correct band bounds", () => {
    const result = computeAllocationBands(sampleAllocations);

    result.bands.forEach((band) => {
      expect(band.lowerBound).toBeLessThanOrEqual(band.recommendedAllocation);
      expect(band.upperBound).toBeGreaterThanOrEqual(band.recommendedAllocation);
      expect(band.lowerBound).toBeGreaterThanOrEqual(0);
      expect(band.upperBound).toBeLessThanOrEqual(100);
    });
  });

  it("should calculate band width correctly", () => {
    const result = computeAllocationBands(sampleAllocations);

    result.bands.forEach((band) => {
      const expectedWidth = band.upperBound - band.lowerBound;
      expect(band.bandWidth).toBeCloseTo(expectedWidth, 2);
    });
  });

  it("should include timestamp", () => {
    const result = computeAllocationBands(sampleAllocations);

    expect(result.calculatedAt).toBeDefined();
    expect(new Date(result.calculatedAt).toISOString()).toBeDefined();
  });

  it("should handle empty allocations", () => {
    const result = computeAllocationBands([]);

    expect(result.bands).toHaveLength(0);
    expect(result.totalAllocation).toBe(0);
    expect(result.portfolioConfidence).toBe(0);
  });

  it("should handle single allocation", () => {
    const singleAllocation = [
      {
        assetId: "USDC",
        recommendedAllocation: 100.0,
        confidenceScore: 0.85,
        volatility: 0.02,
      },
    ];

    const result = computeAllocationBands(singleAllocation);

    expect(result.bands).toHaveLength(1);
    expect(result.totalAllocation).toBe(100.0);
    expect(result.portfolioConfidence).toBe(0.85);
  });

  it("should produce narrower bands for higher confidence", () => {
    const highConfidence = [
      {
        assetId: "USDC",
        recommendedAllocation: 50.0,
        confidenceScore: 0.95,
        volatility: 0.05,
      },
    ];

    const lowConfidence = [
      {
        assetId: "USDC",
        recommendedAllocation: 50.0,
        confidenceScore: 0.50,
        volatility: 0.05,
      },
    ];

    const highResult = computeAllocationBands(highConfidence);
    const lowResult = computeAllocationBands(lowConfidence);

    expect(highResult.bands[0].bandWidth).toBeLessThan(
      lowResult.bands[0].bandWidth,
    );
  });

  it("should produce wider bands for higher volatility", () => {
    const lowVol = [
      {
        assetId: "USDC",
        recommendedAllocation: 50.0,
        confidenceScore: 0.80,
        volatility: 0.05,
      },
    ];

    const highVol = [
      {
        assetId: "USDC",
        recommendedAllocation: 50.0,
        confidenceScore: 0.80,
        volatility: 0.30,
      },
    ];

    const lowResult = computeAllocationBands(lowVol);
    const highResult = computeAllocationBands(highVol);

    expect(highResult.bands[0].bandWidth).toBeGreaterThan(
      lowResult.bands[0].bandWidth,
    );
  });
});

describe("getBandColor", () => {
  it("should return green for very high confidence", () => {
    expect(getBandColor(0.90)).toBe("green");
    expect(getBandColor(0.85)).toBe("green");
  });

  it("should return lightgreen for high confidence", () => {
    expect(getBandColor(0.75)).toBe("lightgreen");
    expect(getBandColor(0.65)).toBe("lightgreen");
  });

  it("should return orange for medium confidence", () => {
    expect(getBandColor(0.55)).toBe("orange");
    expect(getBandColor(0.45)).toBe("orange");
  });

  it("should return red for low confidence", () => {
    expect(getBandColor(0.35)).toBe("red");
    expect(getBandColor(0.25)).toBe("red");
  });

  it("should return darkred for very low confidence", () => {
    expect(getBandColor(0.20)).toBe("darkred");
    expect(getBandColor(0.10)).toBe("darkred");
    expect(getBandColor(0.0)).toBe("darkred");
  });
});

describe("formatAllocationBand", () => {
  it("should format band correctly", () => {
    const band = {
      assetId: "USDC",
      recommendedAllocation: 40.0,
      lowerBound: 37.5,
      upperBound: 42.5,
      bandWidth: 5.0,
      confidenceScore: 0.85,
      volatility: 0.02,
      disclaimer: "Test disclaimer",
    };

    const formatted = formatAllocationBand(band);

    expect(formatted).toBe("40.0% (37.5% - 42.5%)");
  });

  it("should handle decimal places correctly", () => {
    const band = {
      assetId: "ETH",
      recommendedAllocation: 33.333,
      lowerBound: 30.123,
      upperBound: 36.543,
      bandWidth: 6.42,
      confidenceScore: 0.75,
      volatility: 0.15,
      disclaimer: "Test disclaimer",
    };

    const formatted = formatAllocationBand(band);

    expect(formatted).toBe("33.3% (30.1% - 36.5%)");
  });
});
