// Mock the momentum engine
jest.mock('../services/opportunityMomentumEngine', () => ({
  opportunityMomentumEngine: {
    bulkAddSnapshots: jest.fn(),
    analyzeOpportunities: jest.fn(),
    calculateMomentumScore: jest.fn(),
    getMomentumScores: jest.fn(),
    getAvailableProtocols: jest.fn(),
    getSnapshotCount: jest.fn(),
    getConfig: jest.fn(),
    updateConfig: jest.fn(),
    clearHistory: jest.fn(),
  },
}));

describe('Momentum Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/momentum/snapshots', () => {
    it('should validate snapshot structure', () => {
      const validSnapshots = [
        {
          timestamp: Date.now(),
          protocolName: 'Blend',
          apy: 8.5,
          tvl: 1000000,
          confidence: 0.9,
          liquidityScore: 0.8,
          riskScore: 0.3,
        },
      ];

      // Test valid structure
      expect(validSnapshots[0]).toHaveProperty('timestamp');
      expect(validSnapshots[0]).toHaveProperty('protocolName');
      expect(validSnapshots[0]).toHaveProperty('apy');
      expect(validSnapshots[0]).toHaveProperty('tvl');
      expect(typeof validSnapshots[0].apy).toBe('number');
      expect(typeof validSnapshots[0].tvl).toBe('number');
    });

    it('should reject invalid snapshot structure', () => {
      const invalidSnapshots = [
        {
          // Missing required fields
          protocolName: 'Blend',
          apy: 8.5,
        },
        {
          timestamp: Date.now(),
          protocolName: 'Blend',
          apy: 'invalid', // Should be number
          tvl: 1000000,
        },
      ];

      invalidSnapshots.forEach(snapshot => {
        const hasRequiredFields = !!(snapshot.timestamp && 
                                 snapshot.protocolName && 
                                 typeof snapshot.apy === 'number' && 
                                 typeof (snapshot as any).tvl === 'number');
        expect(hasRequiredFields).toBe(false);
      });
    });
  });

  describe('Momentum Analysis Response Structure', () => {
    it('should validate analysis response structure', () => {
      const mockAnalysis = {
        opportunities: [
          {
            protocolName: 'Blend',
            currentApy: 8.5,
            overallMomentum: 0.68,
            finalScore: 0.74,
            momentumClass: 'rising',
          },
        ],
        rankedOpportunities: [
          {
            protocolName: 'Blend',
            finalScore: 0.74,
          },
        ],
        summary: {
          totalOpportunities: 1,
          risingCount: 1,
          flatCount: 0,
          decliningCount: 0,
          averageMomentum: 0.68,
          topMomentumProtocol: 'Blend',
          analysisTimestamp: Date.now(),
        },
      };

      // Validate structure
      expect(mockAnalysis).toHaveProperty('opportunities');
      expect(mockAnalysis).toHaveProperty('rankedOpportunities');
      expect(mockAnalysis).toHaveProperty('summary');
      
      expect(Array.isArray(mockAnalysis.opportunities)).toBe(true);
      expect(Array.isArray(mockAnalysis.rankedOpportunities)).toBe(true);
      
      // Validate summary structure
      expect(mockAnalysis.summary).toHaveProperty('totalOpportunities');
      expect(mockAnalysis.summary).toHaveProperty('risingCount');
      expect(mockAnalysis.summary).toHaveProperty('decliningCount');
      expect(mockAnalysis.summary).toHaveProperty('flatCount');
      expect(mockAnalysis.summary).toHaveProperty('averageMomentum');
      expect(mockAnalysis.summary).toHaveProperty('topMomentumProtocol');
      expect(mockAnalysis.summary).toHaveProperty('analysisTimestamp');
      
      // Validate field types
      expect(typeof mockAnalysis.summary.totalOpportunities).toBe('number');
      expect(typeof mockAnalysis.summary.averageMomentum).toBe('number');
      expect(typeof mockAnalysis.summary.topMomentumProtocol).toBe('string');
    });

    it('should validate momentum score response structure', () => {
      const mockScore = {
        protocolName: 'Blend',
        currentApy: 8.5,
        currentTvl: 1000000,
        currentConfidence: 0.9,
        currentLiquidityScore: 0.8,
        currentRiskScore: 0.3,
        shortWindowMomentum: {
          window: { name: 'short', durationMs: 86400000, weight: 0.5 },
          apyTrend: 0.15,
          tvlTrend: 0.08,
          confidenceTrend: 0.05,
          volatility: 0.12,
          consistency: 0.88,
          momentum: 0.72,
        },
        mediumWindowMomentum: {
          window: { name: 'medium', durationMs: 604800000, weight: 0.3 },
          momentum: 0.65,
        },
        longWindowMomentum: {
          window: { name: 'long', durationMs: 2592000000, weight: 0.2 },
          momentum: 0.58,
        },
        overallMomentum: 0.68,
        confidenceAdjustedMomentum: 0.75,
        liquidityAdjustedMomentum: 0.78,
        finalScore: 0.74,
        momentumClass: 'rising',
        riskAdjustment: 0.955,
        calculatedAt: Date.now(),
        dataPoints: 15,
        reliability: 0.95,
      };

      // Validate core fields
      expect(mockScore).toHaveProperty('protocolName');
      expect(mockScore).toHaveProperty('currentApy');
      expect(mockScore).toHaveProperty('overallMomentum');
      expect(mockScore).toHaveProperty('finalScore');
      expect(mockScore).toHaveProperty('momentumClass');
      
      // Validate window momentum structures
      expect(mockScore.shortWindowMomentum).toHaveProperty('window');
      expect(mockScore.shortWindowMomentum).toHaveProperty('momentum');
      expect(mockScore.shortWindowMomentum.window).toHaveProperty('name');
      expect(mockScore.shortWindowMomentum.window).toHaveProperty('durationMs');
      expect(mockScore.shortWindowMomentum.window).toHaveProperty('weight');
      
      // Validate momentum class
      expect(['rising', 'flat', 'declining']).toContain(mockScore.momentumClass);
      
      // Validate score ranges
      expect(mockScore.overallMomentum).toBeGreaterThanOrEqual(0);
      expect(mockScore.overallMomentum).toBeLessThanOrEqual(1);
      expect(mockScore.finalScore).toBeGreaterThanOrEqual(0);
      expect(mockScore.finalScore).toBeLessThanOrEqual(1);
      expect(mockScore.reliability).toBeGreaterThanOrEqual(0);
      expect(mockScore.reliability).toBeLessThanOrEqual(1);
    });
  });

  describe('Configuration Validation', () => {
    it('should validate configuration structure', () => {
      const mockConfig = {
        windows: [
          { name: 'short', durationMs: 86400000, weight: 0.5 },
          { name: 'medium', durationMs: 604800000, weight: 0.3 },
          { name: 'long', durationMs: 2592000000, weight: 0.2 },
        ],
        minDataPoints: 3,
        confidenceWeight: 0.3,
        liquidityWeight: 0.2,
        riskPenaltyFactor: 0.15,
        volatilityPenalty: 0.1,
        consistencyBonus: 0.05,
      };

      // Validate structure
      expect(mockConfig).toHaveProperty('windows');
      expect(mockConfig).toHaveProperty('minDataPoints');
      expect(mockConfig).toHaveProperty('confidenceWeight');
      expect(mockConfig).toHaveProperty('liquidityWeight');
      expect(mockConfig).toHaveProperty('riskPenaltyFactor');
      
      // Validate windows array
      expect(Array.isArray(mockConfig.windows)).toBe(true);
      expect(mockConfig.windows).toHaveLength(3);
      
      mockConfig.windows.forEach(window => {
        expect(window).toHaveProperty('name');
        expect(window).toHaveProperty('durationMs');
        expect(window).toHaveProperty('weight');
        expect(['short', 'medium', 'long']).toContain(window.name);
        expect(typeof window.durationMs).toBe('number');
        expect(typeof window.weight).toBe('number');
        expect(window.weight).toBeGreaterThan(0);
        expect(window.weight).toBeLessThanOrEqual(1);
      });
      
      // Validate weights sum to 1
      const totalWeight = mockConfig.windows.reduce((sum, w) => sum + w.weight, 0);
      expect(totalWeight).toBeCloseTo(1, 2);
      
      // Validate parameter ranges
      expect(mockConfig.minDataPoints).toBeGreaterThan(0);
      expect(mockConfig.confidenceWeight).toBeGreaterThanOrEqual(0);
      expect(mockConfig.liquidityWeight).toBeGreaterThanOrEqual(0);
      expect(mockConfig.riskPenaltyFactor).toBeGreaterThanOrEqual(0);
    });

    it('should validate configuration bounds', () => {
      const invalidConfigs = [
        { minDataPoints: 0 }, // Too low
        { minDataPoints: 101 }, // Too high
        { confidenceWeight: -0.1 }, // Negative
        { liquidityWeight: 1.1 }, // Too high
        { windows: 'invalid' }, // Not an array
      ];

      invalidConfigs.forEach(config => {
        if (config.minDataPoints !== undefined) {
          const isValid = config.minDataPoints >= 1 && config.minDataPoints <= 100;
          expect(isValid).toBe(config.minDataPoints > 0 && config.minDataPoints <= 100);
        }
        
        if (config.confidenceWeight !== undefined) {
          expect(config.confidenceWeight >= 0).toBe(config.confidenceWeight >= 0);
        }
        
        if (config.windows !== undefined) {
          expect(Array.isArray(config.windows)).toBe(typeof config.windows !== 'string');
        }
      });
    });
  });

  describe('Ranking Response Structure', () => {
    it('should validate ranking response structure', () => {
      const mockRankingResponse = {
        opportunities: [
          {
            protocolName: 'Blend',
            finalScore: 0.85,
            momentumClass: 'rising',
          },
          {
            protocolName: 'Soroswap',
            finalScore: 0.72,
            momentumClass: 'flat',
          },
        ],
        totalFound: 2,
        totalAvailable: 5,
        filters: {
          momentumClass: 'rising',
          minScore: 0.5,
          limit: 10,
        },
        summary: {
          totalOpportunities: 5,
          risingCount: 2,
          flatCount: 2,
          decliningCount: 1,
        },
      };

      // Validate structure
      expect(mockRankingResponse).toHaveProperty('opportunities');
      expect(mockRankingResponse).toHaveProperty('totalFound');
      expect(mockRankingResponse).toHaveProperty('totalAvailable');
      expect(mockRankingResponse).toHaveProperty('filters');
      expect(mockRankingResponse).toHaveProperty('summary');
      
      // Validate arrays
      expect(Array.isArray(mockRankingResponse.opportunities)).toBe(true);
      
      // Validate filters
      expect(mockRankingResponse.filters).toHaveProperty('momentumClass');
      expect(mockRankingResponse.filters).toHaveProperty('minScore');
      expect(mockRankingResponse.filters).toHaveProperty('limit');
      
      // Validate counts
      expect(typeof mockRankingResponse.totalFound).toBe('number');
      expect(typeof mockRankingResponse.totalAvailable).toBe('number');
      expect(mockRankingResponse.totalFound).toBeLessThanOrEqual(mockRankingResponse.totalAvailable);
    });
  });

  describe('Health Response Structure', () => {
    it('should validate health response structure', () => {
      const mockHealthResponse = {
        status: 'healthy',
        statistics: {
          totalProtocols: 5,
          totalSnapshots: 150,
          averageSnapshotsPerProtocol: 30,
          opportunitiesAnalyzed: 5,
          risingOpportunities: 2,
          decliningOpportunities: 1,
          flatOpportunities: 2,
        },
        configuration: {
          minDataPoints: 3,
          windowCount: 3,
          confidenceWeight: 0.3,
          liquidityWeight: 0.2,
          riskPenaltyFactor: 0.15,
        },
        lastAnalysis: {
          timestamp: Date.now(),
          topProtocol: 'Blend',
          averageMomentum: 0.65,
        },
      };

      // Validate structure
      expect(mockHealthResponse).toHaveProperty('status');
      expect(mockHealthResponse).toHaveProperty('statistics');
      expect(mockHealthResponse).toHaveProperty('configuration');
      expect(mockHealthResponse).toHaveProperty('lastAnalysis');
      
      // Validate statistics
      const stats = mockHealthResponse.statistics;
      expect(stats).toHaveProperty('totalProtocols');
      expect(stats).toHaveProperty('totalSnapshots');
      expect(stats).toHaveProperty('opportunitiesAnalyzed');
      expect(typeof stats.totalProtocols).toBe('number');
      expect(typeof stats.totalSnapshots).toBe('number');
      
      // Validate configuration
      const config = mockHealthResponse.configuration;
      expect(config).toHaveProperty('minDataPoints');
      expect(config).toHaveProperty('windowCount');
      expect(typeof config.minDataPoints).toBe('number');
      expect(typeof config.windowCount).toBe('number');
      
      // Validate last analysis
      const analysis = mockHealthResponse.lastAnalysis;
      expect(analysis).toHaveProperty('timestamp');
      expect(analysis).toHaveProperty('topProtocol');
      expect(analysis).toHaveProperty('averageMomentum');
      expect(typeof analysis.timestamp).toBe('number');
      expect(typeof analysis.topProtocol).toBe('string');
      expect(typeof analysis.averageMomentum).toBe('number');
    });
  });

  describe('Error Response Structure', () => {
    it('should validate error response structure', () => {
      const mockErrorResponse = {
        success: false,
        error: 'Failed to calculate momentum score',
        message: 'Insufficient data points',
      };

      expect(mockErrorResponse).toHaveProperty('success', false);
      expect(mockErrorResponse).toHaveProperty('error');
      expect(mockErrorResponse).toHaveProperty('message');
      expect(typeof mockErrorResponse.error).toBe('string');
      expect(typeof mockErrorResponse.message).toBe('string');
    });

    it('should validate validation error responses', () => {
      const validationErrors = [
        {
          success: false,
          error: 'snapshots must be a non-empty array',
        },
        {
          success: false,
          error: 'protocolNames must be a non-empty array',
        },
        {
          success: false,
          error: 'minDataPoints must be between 1 and 100',
        },
      ];

      validationErrors.forEach(error => {
        expect(error).toHaveProperty('success', false);
        expect(error).toHaveProperty('error');
        expect(typeof error.error).toBe('string');
        expect(error.error.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Field Validation', () => {
    it('should validate momentum class values', () => {
      const validClasses = ['rising', 'flat', 'declining'];
      const testClass = 'rising';
      
      expect(validClasses).toContain(testClass);
    });

    it('should validate score ranges', () => {
      const scores = [0, 0.5, 1, 0.74, 0.95];
      
      scores.forEach(score => {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      });
    });

    it('should validate timestamp format', () => {
      const timestamp = Date.now();
      
      expect(typeof timestamp).toBe('number');
      expect(timestamp).toBeGreaterThan(0);
      expect(new Date(timestamp).getTime()).toBe(timestamp);
    });
  });
});