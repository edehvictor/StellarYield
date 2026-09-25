import { predictApy, HistoricalDataPoint } from "../analytics/apyPredictor";

describe("APY Predictor Backtest", () => {
  it("measures forecast quality and confidence calibration against historical fixtures", () => {
    // Generate a fixed historical fixture of APY data simulating a rising and falling trend
    const fixture: HistoricalDataPoint[] = Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - (30 - i) * 86400000).toISOString(),
      apy: 5 + Math.sin(i / 5) * 2 + i * 0.1, // Rising sine wave
    }));

    // Hold out the last 7 days for validation
    const trainingData = fixture.slice(0, 23);
    const heldOutData = fixture.slice(23, 30);

    const result = predictApy("TestProtocol", trainingData, 7);

    expect(result.predictions).toHaveLength(7);

    result.predictions.forEach((prediction, index) => {
      const actual = heldOutData[index].apy;
      const error = Math.abs(prediction.predictedApy - actual);

      // Error should be somewhat bounded in a predictable test set
      expect(error).toBeLessThan(3);

      // Confidence should naturally decrease further into the future
      if (index > 0) {
        expect(prediction.confidence).toBeLessThanOrEqual(result.predictions[index - 1].confidence);
      }
    });
  });

  it("detects unstable forecasts when data is highly volatile", () => {
    // Generate highly volatile data
    const volatileFixture: HistoricalDataPoint[] = Array.from({ length: 14 }, (_, i) => ({
      date: new Date(Date.now() - (14 - i) * 86400000).toISOString(),
      apy: i % 2 === 0 ? 1 : 20, // Alternates wildly
    }));

    const result = predictApy("VolatileProtocol", volatileFixture, 7);

    // Should predict something, but confidence should be lower due to bad R^2 fit
    expect(result.predictions[0].confidence).toBeLessThan(0.75);
  });
});
