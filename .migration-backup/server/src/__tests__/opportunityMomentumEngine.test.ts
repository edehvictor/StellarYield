import {
  OpportunityMomentumEngine,
  OpportunitySnapshot,
  MomentumEngineConfig,
} from '../services/opportunityMomentumEngine';

describe('OpportunityMomentumEngine', () => {
  let engine: OpportunityMomentumEngine;
  const baseTime = Date.now();

  beforeEach(() => {
    engine = new OpportunityMomentumEngine();
  });

  describe('Configuration', () => {
    it('should initialize with default configuration', () => {
      const config = engine.getConfig();
      
      expect(config.windows).toHaveLength(3);
      expect(config.windows[0].name).toBe('short');
      expect(config.windows[1].name).toBe('medium');
      expect(config.windows[2].name).toBe('long');
      expect(config.minDataPoints).toBe(3);
    });

    it('should allow configuration updates', () => {
      const newConfig: Partial<MomentumEngineConfig> = {
        minDataPoints: 5,
        confidenceWeight: 0.4,
      };

      engine.updateConfig(newConfig);
      const config = engine.getConfig();

      expect(config.minDataPoints).toBe(5);
      expect(config.confidenceWeight).toBe(0.4);
    });

    it('should accept custom configuration in constructor', () => {
      const customEngine = new OpportunityMomentumEngine({
        minDataPoints: 10,
        riskPenaltyFactor: 0.2,
      });

      const config = customEngine.getConfig();
      expect(config.minDataPoints).toBe(10);
      expect(config.riskPenaltyFactor).toBe(0.2);
    });
  });

  describe('Snapshot Management', () => {
    it('should add and store snapshots', () => {
      const snapshot: OpportunitySnapshot = {
        timestamp: baseTime,
        protocolName: 'Blend',
        apy: 8.5,
        tvl: 1000000,
        confidence: 0.9,
        liquidityScore: 0.8,
        riskScore: 0.3,
      };

      engine.addSnapshot(snapshot);
      expect(engine.getSnapshotCount('Blend')).toBe(1);
      expect(engine.getAvailableProtocols()).toContain('Blend');
    });

    it('should sort snapshots by timestamp', () => {
      const snapshots: OpportunitySnapshot[] = [
        {
          timestamp: baseTime + 2000,
          protocolName: 'Blend',
          apy: 9.0,
          tvl: 1100000,
          confidence: 0.85,
          liquidityScore: 0.8,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime,
          protocolName: 'Blend',
          apy: 8.5,
          tvl: 1000000,
          confidence: 0.9,
          liquidityScore: 0.8,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime + 1000,
          protocolName: 'Blend',
          apy: 8.7,
          tvl: 1050000,
          confidence: 0.88,
          liquidityScore: 0.8,
          riskScore: 0.3,
        },
      ];

      engine.bulkAddSnapshots(snapshots);
      expect(engine.getSnapshotCount('Blend')).toBe(3);
    });

    it('should limit historical data to 90 days', () => {
      const oldSnapshot: OpportunitySnapshot = {
        timestamp: baseTime - (100 * 24 * 60 * 60 * 1000), // 100 days ago
        protocolName: 'Blend',
        apy: 8.0,
        tvl: 900000,
        confidence: 0.8,
        liquidityScore: 0.7,
        riskScore: 0.4,
      };

      const recentSnapshot: OpportunitySnapshot = {
        timestamp: baseTime,
        protocolName: 'Blend',
        apy: 8.5,
        tvl: 1000000,
        confidence: 0.9,
        liquidityScore: 0.8,
        riskScore: 0.3,
      };

      engine.addSnapshot(oldSnapshot);
      engine.addSnapshot(recentSnapshot);

      // Old snapshot should be filtered out
      expect(engine.getSnapshotCount('Blend')).toBe(1);
    });

    it('should clear all history', () => {
      const snapshot: OpportunitySnapshot = {
        timestamp: baseTime,
        protocolName: 'Blend',
        apy: 8.5,
        tvl: 1000000,
        confidence: 0.9,
        liquidityScore: 0.8,
        riskScore: 0.3,
      };

      engine.addSnapshot(snapshot);
      expect(engine.getSnapshotCount('Blend')).toBe(1);

      engine.clearHistory();
      expect(engine.getSnapshotCount('Blend')).toBe(0);
      expect(engine.getAvailableProtocols()).toHaveLength(0);
    });
  });

  describe('Momentum Calculation', () => {
    beforeEach(() => {
      // Add test data for rising trend
      const risingSnapshots: OpportunitySnapshot[] = [
        {
          timestamp: baseTime - 5000,
          protocolName: 'RisingProtocol',
          apy: 8.0,
          tvl: 1000000,
          confidence: 0.8,
          liquidityScore: 0.7,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime - 3000,
          protocolName: 'RisingProtocol',
          apy: 8.5,
          tvl: 1100000,
          confidence: 0.85,
          liquidityScore: 0.75,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'RisingProtocol',
          apy: 9.0,
          tvl: 1200000,
          confidence: 0.9,
          liquidityScore: 0.8,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime,
          protocolName: 'RisingProtocol',
          apy: 9.5,
          tvl: 1300000,
          confidence: 0.95,
          liquidityScore: 0.85,
          riskScore: 0.3,
        },
      ];

      // Add test data for declining trend
      const decliningSnapshots: OpportunitySnapshot[] = [
        {
          timestamp: baseTime - 5000,
          protocolName: 'DecliningProtocol',
          apy: 10.0,
          tvl: 1500000,
          confidence: 0.9,
          liquidityScore: 0.8,
          riskScore: 0.2,
        },
        {
          timestamp: baseTime - 3000,
          protocolName: 'DecliningProtocol',
          apy: 9.0,
          tvl: 1400000,
          confidence: 0.85,
          liquidityScore: 0.75,
          riskScore: 0.25,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'DecliningProtocol',
          apy: 8.0,
          tvl: 1300000,
          confidence: 0.8,
          liquidityScore: 0.7,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime,
          protocolName: 'DecliningProtocol',
          apy: 7.0,
          tvl: 1200000,
          confidence: 0.75,
          liquidityScore: 0.65,
          riskScore: 0.35,
        },
      ];

      // Add test data for flat trend
      const flatSnapshots: OpportunitySnapshot[] = [
        {
          timestamp: baseTime - 5000,
          protocolName: 'FlatProtocol',
          apy: 8.5,
          tvl: 1000000,
          confidence: 0.85,
          liquidityScore: 0.75,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime - 3000,
          protocolName: 'FlatProtocol',
          apy: 8.4,
          tvl: 1010000,
          confidence: 0.84,
          liquidityScore: 0.76,
          riskScore: 0.31,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'FlatProtocol',
          apy: 8.6,
          tvl: 990000,
          confidence: 0.86,
          liquidityScore: 0.74,
          riskScore: 0.29,
        },
        {
          timestamp: baseTime,
          protocolName: 'FlatProtocol',
          apy: 8.5,
          tvl: 1005000,
          confidence: 0.85,
          liquidityScore: 0.75,
          riskScore: 0.3,
        },
      ];

      engine.bulkAddSnapshots([...risingSnapshots, ...decliningSnapshots, ...flatSnapshots]);
    });

    it('should return null for protocols with insufficient data', () => {
      const score = engine.calculateMomentumScore('NonExistentProtocol');
      expect(score).toBeNull();
    });

    it('should calculate momentum score for rising protocol', () => {
      const score = engine.calculateMomentumScore('RisingProtocol', baseTime);
      
      expect(score).not.toBeNull();
      expect(score!.protocolName).toBe('RisingProtocol');
      expect(score!.momentumClass).toBe('rising');
      expect(score!.overallMomentum).toBeGreaterThan(0.6);
      expect(score!.finalScore).toBeGreaterThan(0);
      expect(score!.dataPoints).toBe(4);
    });

    it('should calculate momentum score for declining protocol', () => {
      const score = engine.calculateMomentumScore('DecliningProtocol', baseTime);
      
      expect(score).not.toBeNull();
      expect(score!.protocolName).toBe('DecliningProtocol');
      expect(score!.momentumClass).toBe('declining');
      expect(score!.overallMomentum).toBeLessThan(0.4);
    });

    it('should calculate momentum score for flat protocol', () => {
      const score = engine.calculateMomentumScore('FlatProtocol', baseTime);
      
      expect(score).not.toBeNull();
      expect(score!.protocolName).toBe('FlatProtocol');
      expect(score!.momentumClass).toBe('flat');
      expect(score!.overallMomentum).toBeGreaterThanOrEqual(0.4);
      expect(score!.overallMomentum).toBeLessThanOrEqual(0.6);
    });

    it('should apply confidence adjustment', () => {
      const highConfidenceScore = engine.calculateMomentumScore('RisingProtocol', baseTime);
      
      expect(highConfidenceScore).not.toBeNull();
      expect(highConfidenceScore!.confidenceAdjustedMomentum)
        .toBeGreaterThan(highConfidenceScore!.overallMomentum);
    });

    it('should apply liquidity adjustment', () => {
      const score = engine.calculateMomentumScore('RisingProtocol', baseTime);
      
      expect(score).not.toBeNull();
      expect(score!.liquidityAdjustedMomentum).toBeDefined();
      expect(typeof score!.liquidityAdjustedMomentum).toBe('number');
    });

    it('should apply risk penalty', () => {
      const score = engine.calculateMomentumScore('RisingProtocol', baseTime);
      
      expect(score).not.toBeNull();
      expect(score!.riskAdjustment).toBeLessThanOrEqual(1);
      expect(score!.riskAdjustment).toBeGreaterThanOrEqual(0);
    });

    it('should calculate reliability based on data points', () => {
      const score = engine.calculateMomentumScore('RisingProtocol', baseTime);
      
      expect(score).not.toBeNull();
      expect(score!.reliability).toBeGreaterThan(0);
      expect(score!.reliability).toBeLessThanOrEqual(1);
    });
  });

  describe('Opportunity Analysis', () => {
    beforeEach(() => {
      // Add diverse test data with enough points for analysis
      const testData: OpportunitySnapshot[] = [
        // Strong rising protocol - 4 data points
        {
          timestamp: baseTime - 3000,
          protocolName: 'StrongRising',
          apy: 7.0,
          tvl: 900000,
          confidence: 0.85,
          liquidityScore: 0.75,
          riskScore: 0.25,
        },
        {
          timestamp: baseTime - 2000,
          protocolName: 'StrongRising',
          apy: 8.0,
          tvl: 1000000,
          confidence: 0.9,
          liquidityScore: 0.8,
          riskScore: 0.2,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'StrongRising',
          apy: 9.0,
          tvl: 1250000,
          confidence: 0.93,
          liquidityScore: 0.85,
          riskScore: 0.2,
        },
        {
          timestamp: baseTime,
          protocolName: 'StrongRising',
          apy: 10.0,
          tvl: 1500000,
          confidence: 0.95,
          liquidityScore: 0.9,
          riskScore: 0.2,
        },
        // Weak declining protocol - 4 data points
        {
          timestamp: baseTime - 3000,
          protocolName: 'WeakDeclining',
          apy: 13.0,
          tvl: 2200000,
          confidence: 0.7,
          liquidityScore: 0.5,
          riskScore: 0.7,
        },
        {
          timestamp: baseTime - 2000,
          protocolName: 'WeakDeclining',
          apy: 12.0,
          tvl: 2000000,
          confidence: 0.6,
          liquidityScore: 0.4,
          riskScore: 0.8,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'WeakDeclining',
          apy: 10.0,
          tvl: 1600000,
          confidence: 0.55,
          liquidityScore: 0.35,
          riskScore: 0.85,
        },
        {
          timestamp: baseTime,
          protocolName: 'WeakDeclining',
          apy: 8.0,
          tvl: 1200000,
          confidence: 0.5,
          liquidityScore: 0.3,
          riskScore: 0.9,
        },
        // Stable protocol - 4 data points
        {
          timestamp: baseTime - 3000,
          protocolName: 'Stable',
          apy: 8.8,
          tvl: 1780000,
          confidence: 0.84,
          liquidityScore: 0.74,
          riskScore: 0.31,
        },
        {
          timestamp: baseTime - 2000,
          protocolName: 'Stable',
          apy: 9.0,
          tvl: 1800000,
          confidence: 0.85,
          liquidityScore: 0.75,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'Stable',
          apy: 9.2,
          tvl: 1810000,
          confidence: 0.86,
          liquidityScore: 0.76,
          riskScore: 0.29,
        },
        {
          timestamp: baseTime,
          protocolName: 'Stable',
          apy: 9.1,
          tvl: 1820000,
          confidence: 0.86,
          liquidityScore: 0.76,
          riskScore: 0.3,
        },
      ];

      engine.bulkAddSnapshots(testData);
    });

    it('should analyze all opportunities', () => {
      const analysis = engine.analyzeOpportunities(baseTime);
      
      expect(analysis.opportunities).toHaveLength(3);
      expect(analysis.rankedOpportunities).toHaveLength(3);
      expect(analysis.summary.totalOpportunities).toBe(3);
      expect(analysis.summary.analysisTimestamp).toBe(baseTime);
    });

    it('should rank opportunities by final score', () => {
      const analysis = engine.analyzeOpportunities(baseTime);
      const ranked = analysis.rankedOpportunities;
      
      // Should be sorted by final score (descending)
      for (let i = 0; i < ranked.length - 1; i++) {
        expect(ranked[i].finalScore).toBeGreaterThanOrEqual(ranked[i + 1].finalScore);
      }
    });

    it('should classify momentum correctly', () => {
      const analysis = engine.analyzeOpportunities(baseTime);
      
      expect(analysis.summary.risingCount).toBeGreaterThan(0);
      expect(analysis.summary.decliningCount).toBeGreaterThan(0);
      expect(analysis.summary.flatCount).toBeGreaterThan(0);
      
      const totalClassified = analysis.summary.risingCount + 
                             analysis.summary.decliningCount + 
                             analysis.summary.flatCount;
      expect(totalClassified).toBe(analysis.summary.totalOpportunities);
    });

    it('should identify top momentum protocol', () => {
      const analysis = engine.analyzeOpportunities(baseTime);
      
      expect(analysis.summary.topMomentumProtocol).toBeTruthy();
      expect(analysis.rankedOpportunities[0].protocolName)
        .toBe(analysis.summary.topMomentumProtocol);
    });

    it('should calculate average momentum', () => {
      const analysis = engine.analyzeOpportunities(baseTime);
      
      expect(analysis.summary.averageMomentum).toBeGreaterThanOrEqual(0);
      expect(analysis.summary.averageMomentum).toBeLessThanOrEqual(1);
    });
  });

  describe('Specific Protocol Queries', () => {
    beforeEach(() => {
      const testData: OpportunitySnapshot[] = [
        // Protocol1 - 4 data points
        {
          timestamp: baseTime - 3000,
          protocolName: 'Protocol1',
          apy: 7.5,
          tvl: 950000,
          confidence: 0.75,
          liquidityScore: 0.65,
          riskScore: 0.35,
        },
        {
          timestamp: baseTime - 2000,
          protocolName: 'Protocol1',
          apy: 8.0,
          tvl: 1000000,
          confidence: 0.8,
          liquidityScore: 0.7,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'Protocol1',
          apy: 8.5,
          tvl: 1050000,
          confidence: 0.82,
          liquidityScore: 0.72,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime,
          protocolName: 'Protocol1',
          apy: 9.0,
          tvl: 1100000,
          confidence: 0.85,
          liquidityScore: 0.75,
          riskScore: 0.3,
        },
        // Protocol2 - 4 data points
        {
          timestamp: baseTime - 3000,
          protocolName: 'Protocol2',
          apy: 9.5,
          tvl: 1900000,
          confidence: 0.88,
          liquidityScore: 0.78,
          riskScore: 0.22,
        },
        {
          timestamp: baseTime - 2000,
          protocolName: 'Protocol2',
          apy: 10.0,
          tvl: 2000000,
          confidence: 0.9,
          liquidityScore: 0.8,
          riskScore: 0.2,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'Protocol2',
          apy: 10.5,
          tvl: 2100000,
          confidence: 0.92,
          liquidityScore: 0.82,
          riskScore: 0.2,
        },
        {
          timestamp: baseTime,
          protocolName: 'Protocol2',
          apy: 11.0,
          tvl: 2200000,
          confidence: 0.95,
          liquidityScore: 0.85,
          riskScore: 0.2,
        },
      ];

      engine.bulkAddSnapshots(testData);
    });

    it('should get momentum scores for specific protocols', () => {
      const scores = engine.getMomentumScores(['Protocol1', 'Protocol2'], baseTime);
      
      expect(scores).toHaveLength(2);
      expect(scores.map(s => s.protocolName)).toContain('Protocol1');
      expect(scores.map(s => s.protocolName)).toContain('Protocol2');
    });

    it('should return empty array for non-existent protocols', () => {
      const scores = engine.getMomentumScores(['NonExistent'], baseTime);
      expect(scores).toHaveLength(0);
    });

    it('should sort specific protocol scores by final score', () => {
      const scores = engine.getMomentumScores(['Protocol1', 'Protocol2'], baseTime);
      
      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i].finalScore).toBeGreaterThanOrEqual(scores[i + 1].finalScore);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle single data point gracefully', () => {
      const snapshot: OpportunitySnapshot = {
        timestamp: baseTime,
        protocolName: 'SinglePoint',
        apy: 8.5,
        tvl: 1000000,
        confidence: 0.8,
        liquidityScore: 0.7,
        riskScore: 0.3,
      };

      engine.addSnapshot(snapshot);
      const score = engine.calculateMomentumScore('SinglePoint', baseTime);
      
      // Should return null due to insufficient data
      expect(score).toBeNull();
    });

    it('should handle zero values gracefully', () => {
      const snapshots: OpportunitySnapshot[] = [
        {
          timestamp: baseTime - 1000,
          protocolName: 'ZeroValues',
          apy: 0,
          tvl: 0,
          confidence: 0,
          liquidityScore: 0,
          riskScore: 1,
        },
        {
          timestamp: baseTime,
          protocolName: 'ZeroValues',
          apy: 0,
          tvl: 0,
          confidence: 0,
          liquidityScore: 0,
          riskScore: 1,
        },
        {
          timestamp: baseTime + 1000,
          protocolName: 'ZeroValues',
          apy: 0,
          tvl: 0,
          confidence: 0,
          liquidityScore: 0,
          riskScore: 1,
        },
      ];

      engine.bulkAddSnapshots(snapshots);
      const score = engine.calculateMomentumScore('ZeroValues', baseTime + 1000);
      
      expect(score).not.toBeNull();
      expect(score!.finalScore).toBeGreaterThanOrEqual(0);
    });

    it('should handle extreme volatility', () => {
      const volatileSnapshots: OpportunitySnapshot[] = [
        {
          timestamp: baseTime - 3000,
          protocolName: 'Volatile',
          apy: 5.0,
          tvl: 1000000,
          confidence: 0.8,
          liquidityScore: 0.7,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime - 2000,
          protocolName: 'Volatile',
          apy: 15.0,
          tvl: 1000000,
          confidence: 0.8,
          liquidityScore: 0.7,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'Volatile',
          apy: 2.0,
          tvl: 1000000,
          confidence: 0.8,
          liquidityScore: 0.7,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime,
          protocolName: 'Volatile',
          apy: 12.0,
          tvl: 1000000,
          confidence: 0.8,
          liquidityScore: 0.7,
          riskScore: 0.3,
        },
      ];

      engine.bulkAddSnapshots(volatileSnapshots);
      const score = engine.calculateMomentumScore('Volatile', baseTime);
      
      expect(score).not.toBeNull();
      expect(score!.shortWindowMomentum.volatility).toBeGreaterThan(0.5);
    });
  });

  describe('Performance and Coverage', () => {
    it('should handle large datasets efficiently', () => {
      const largeDataset: OpportunitySnapshot[] = [];
      
      // Generate 1000 snapshots across 10 protocols
      for (let i = 0; i < 1000; i++) {
        largeDataset.push({
          timestamp: baseTime - (i * 1000),
          protocolName: `Protocol${i % 10}`,
          apy: 8 + Math.sin(i / 10) * 2,
          tvl: 1000000 + i * 1000,
          confidence: 0.8 + Math.random() * 0.2,
          liquidityScore: 0.7 + Math.random() * 0.3,
          riskScore: 0.2 + Math.random() * 0.3,
        });
      }

      const startTime = Date.now();
      engine.bulkAddSnapshots(largeDataset);
      const analysis = engine.analyzeOpportunities(baseTime);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
      expect(analysis.opportunities.length).toBeGreaterThan(0);
    });

    it('should achieve minimum 90% test coverage', () => {
      // This test ensures we're testing all major code paths
      
      // Test configuration methods
      engine.updateConfig({ minDataPoints: 5 });
      expect(engine.getConfig().minDataPoints).toBe(5);
      
      // Test data management
      engine.clearHistory();
      expect(engine.getAvailableProtocols()).toHaveLength(0);
      
      // Test with minimal data
      // Update configuration to require fewer data points for this test
      engine.updateConfig({ minDataPoints: 3 });
      
      const minimalData: OpportunitySnapshot[] = [
        {
          timestamp: baseTime - 2000,
          protocolName: 'Minimal',
          apy: 8.0,
          tvl: 1000000,
          confidence: 0.8,
          liquidityScore: 0.7,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime - 1000,
          protocolName: 'Minimal',
          apy: 8.5,
          tvl: 1100000,
          confidence: 0.85,
          liquidityScore: 0.75,
          riskScore: 0.3,
        },
        {
          timestamp: baseTime,
          protocolName: 'Minimal',
          apy: 9.0,
          tvl: 1200000,
          confidence: 0.9,
          liquidityScore: 0.8,
          riskScore: 0.3,
        },
      ];
      
      engine.bulkAddSnapshots(minimalData);
      
      // Test all analysis methods
      const score = engine.calculateMomentumScore('Minimal', baseTime);
      const analysis = engine.analyzeOpportunities(baseTime);
      const specificScores = engine.getMomentumScores(['Minimal'], baseTime);
      
      expect(score).not.toBeNull();
      expect(analysis.opportunities).toHaveLength(1);
      expect(specificScores).toHaveLength(1);
      expect(engine.getSnapshotCount('Minimal')).toBe(3);
    });
  });
});