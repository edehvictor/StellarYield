import { yieldQuorumService } from "../services/yieldQuorumService";
import { aggregateApy } from "../services/yieldService";
import { predictApy, HistoricalDataPoint } from "../analytics/apyPredictor";

describe("APY Source Quorum Policy & Verification", () => {
  beforeEach(() => {
    // Reset configs to defaults before each test
    yieldQuorumService.setConfig("Blend", { minSourceCount: 2, maxFreshnessAgeSeconds: 900 });
    yieldQuorumService.setConfig("Soroswap", { minSourceCount: 2, maxFreshnessAgeSeconds: 900 });
  });

  describe("Quorum Configuration & Rules", () => {
    it("defines default minimum source count and freshness requirements per protocol", () => {
      const blendConfig = yieldQuorumService.getConfig("Blend");
      expect(blendConfig.minSourceCount).toBe(2);
      expect(blendConfig.maxFreshnessAgeSeconds).toBe(900);

      const soroswapConfig = yieldQuorumService.getConfig("Soroswap");
      expect(soroswapConfig.minSourceCount).toBe(2);
      expect(soroswapConfig.maxFreshnessAgeSeconds).toBe(900);
    });

    it("allows updating per-protocol quorum configuration", () => {
      yieldQuorumService.setConfig("Blend", { minSourceCount: 3, maxFreshnessAgeSeconds: 300 });
      const updated = yieldQuorumService.getConfig("Blend");
      expect(updated.minSourceCount).toBe(3);
      expect(updated.maxFreshnessAgeSeconds).toBe(300);
    });
  });

  describe("Quorum Evaluation Signals", () => {
    it("fails quorum when source count is below minimum requirement", () => {
      const readings = [{ provider: "Blend_Main", apy: 0.08, fetchedAt: new Date().toISOString() }];
      const quorum = yieldQuorumService.evaluateQuorum("Blend", readings);

      expect(quorum.isMet).toBe(false);
      expect(quorum.validSourceCount).toBe(1);
      expect(quorum.requiredMinSources).toBe(2);
      expect(quorum.reasons).toContain("quorum_not_met");
    });

    it("passes quorum when sufficient fresh valid sources are available", () => {
      const now = Date.now();
      const readings = [
        { provider: "Blend_Oracle1", apy: 0.08, fetchedAt: new Date(now - 60000).toISOString() },
        { provider: "Blend_Oracle2", apy: 0.082, fetchedAt: new Date(now - 120000).toISOString() },
      ];
      const quorum = yieldQuorumService.evaluateQuorum("Blend", readings, now);

      expect(quorum.isMet).toBe(true);
      expect(quorum.validSourceCount).toBe(2);
      expect(quorum.staleSourceCount).toBe(0);
      expect(quorum.failingSourceCount).toBe(0);
    });

    it("detects stale sources exceeding maxFreshnessAgeSeconds", () => {
      const now = Date.now();
      const readings = [
        { provider: "SourceA", apy: 0.05, fetchedAt: new Date(now - 60000).toISOString() }, // fresh (1 min old)
        { provider: "SourceB", apy: 0.051, fetchedAt: new Date(now - 1800000).toISOString() }, // stale (30 min old)
      ];
      const quorum = yieldQuorumService.evaluateQuorum("Blend", readings, now);

      expect(quorum.isMet).toBe(false);
      expect(quorum.validSourceCount).toBe(1);
      expect(quorum.staleSourceCount).toBe(1);
      expect(quorum.reasons).toContain("quorum_not_met");
    });

    it("detects failing or unavailable sources", () => {
      const readings = [
        { provider: "SourceA", apy: 0.05, fetchedAt: new Date().toISOString() },
        { provider: "SourceB", apy: 0.051, fetchedAt: new Date().toISOString(), isFailing: true },
      ];
      const quorum = yieldQuorumService.evaluateQuorum("Blend", readings);

      expect(quorum.isMet).toBe(false);
      expect(quorum.validSourceCount).toBe(1);
      expect(quorum.failingSourceCount).toBe(1);
    });
  });

  describe("Aggregate APY Quorum Integration & Confidence Degradation", () => {
    it("attaches quorum status to aggregate APY responses", () => {
      const readings = [
        { provider: "SourceA", apy: 0.05, fetchedAt: new Date().toISOString() },
        { provider: "SourceB", apy: 0.052, fetchedAt: new Date().toISOString() },
      ];
      const result = aggregateApy(readings, "Blend");

      expect(result.quorumStatus).toBeDefined();
      expect(result.quorumStatus.isMet).toBe(true);
      expect(result.consensusApy).toBeGreaterThan(0.049);
    });

    it("degrades confidence when quorum is not met", () => {
      const singleSourceReadings = [
        { provider: "SourceA", apy: 0.05, fetchedAt: new Date().toISOString() },
      ];

      const fullReadings = [
        { provider: "SourceA", apy: 0.05, fetchedAt: new Date().toISOString() },
        { provider: "SourceB", apy: 0.052, fetchedAt: new Date().toISOString() },
      ];

      const resSingle = aggregateApy(singleSourceReadings, "Blend");
      const resFull = aggregateApy(fullReadings, "Blend");

      expect(resSingle.quorumStatus.isMet).toBe(false);
      expect(resFull.quorumStatus.isMet).toBe(true);

      expect(resSingle.confidence.score).toBeLessThan(resFull.confidence.score);
      expect(resSingle.confidence.reasons).toContain("quorum_not_met");
    });
  });

  describe("APY Predictor Quorum Integration", () => {
    it("attaches quorum status and degrades prediction confidence when quorum fails", () => {
      const historical: HistoricalDataPoint[] = [];
      const now = new Date();
      for (let i = 9; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        historical.push({ date: d.toISOString().split("T")[0], apy: 6.0 + i * 0.1 });
      }

      // Single failing source -> quorum fails
      const sources = [
        { provider: "SingleSource", apy: 6.5, fetchedAt: new Date().toISOString() },
      ];

      const prediction = predictApy("Blend", historical, 7, sources);

      expect(prediction.quorumStatus).toBeDefined();
      expect(prediction.quorumStatus?.isMet).toBe(false);
      expect(prediction.predictions.length).toBe(7);

      // Prediction confidence should be degraded (< 0.5)
      for (const p of prediction.predictions) {
        expect(p.confidence).toBeLessThan(0.5);
      }
    });

    it("provides normal prediction confidence when quorum is met", () => {
      const historical: HistoricalDataPoint[] = [];
      const now = new Date();
      for (let i = 9; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        historical.push({ date: d.toISOString().split("T")[0], apy: 6.0 + (9 - i) * 0.1 });
      }

      const sources = [
        { provider: "Source1", apy: 6.0, fetchedAt: new Date().toISOString() },
        { provider: "Source2", apy: 6.0, fetchedAt: new Date().toISOString() },
      ];

      const prediction = predictApy("Blend", historical, 7, sources);

      expect(prediction.quorumStatus?.isMet).toBe(true);
      expect(prediction.predictions[0].confidence).toBeGreaterThan(0.5);
    });
  });
});
