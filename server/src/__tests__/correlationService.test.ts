import { calculatePearsonCorrelation, CorrelationService } from "../services/correlationService";

describe("Correlation Math", () => {
  it("calculates pearson correlation +1 for identical data", () => {
    const dataX = [1, 2, 3, 4, 5];
    const dataY = [1, 2, 3, 4, 5];
    expect(calculatePearsonCorrelation(dataX, dataY, 5)).toBeCloseTo(1.0);
  });

  it("calculates pearson correlation -1 for inverted data", () => {
    const dataX = [1, 2, 3, 4, 5];
    const dataY = [5, 4, 3, 2, 1];
    expect(calculatePearsonCorrelation(dataX, dataY, 5)).toBeCloseTo(-1.0);
  });

  it("throws safely when data window is incomplete", () => {
    const dataX = [1, 2, 3];
    const dataY = [1, 2, 3];
    expect(() => calculatePearsonCorrelation(dataX, dataY, 5)).toThrow(/Incomplete data window/);
  });

  it("handles empty arrays", () => {
    const dataX: number[] = [];
    const dataY: number[] = [];
    expect(calculatePearsonCorrelation(dataX, dataY, 0)).toBe(0);
  });
});

describe("CorrelationService", () => {
  it("generates a valid n x n matrix", async () => {
    const result = await CorrelationService.getCorrelationMatrix(30);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.matrix.length).toBe(result.items.length);
    expect(result.matrix[0].length).toBe(result.items.length);

    // Diagonal should be 1.0
    expect(result.matrix[0][0]).toBe(1.0);
  });

  it("surfaces concentration warnings correctly", async () => {
    // Generate data with threshold 0.0 (everything is highly correlated)
    const result = await CorrelationService.getCorrelationMatrix(30, 0.0);
    // Since we mock it, at least some items will trigger it
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/High correlation detected/);
  });
});
