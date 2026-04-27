import { 
  PortfolioAttributionEngine, 
  portfolioAttributionEngine,
  validateAttributionRequest,
  formatAttributionReport 
} from '../portfolioAttributionService';

// Mock dependencies
jest.mock('node-cache');
jest.mock('../stellarNetworkService');
jest.mock('../freezeService');

describe('PortfolioAttributionService', () => {
  let engine: PortfolioAttributionEngine;

  beforeEach(() => {
    engine = new PortfolioAttributionEngine();
    jest.clearAllMocks();
  });

  describe('validateAttributionRequest', () => {
    it('should validate correct request parameters', () => {
      const result = validateAttributionRequest(
        'GD5XQ2Z7WLOLF5SKDJU5LJY45JFIOE2M5M2Y6QPEXGA5RYKQZTUKY2U',
        '2026-03-01T00:00:00Z',
        '2026-04-01T00:00:00Z'
      );

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject invalid wallet address', () => {
      const result = validateAttributionRequest(
        'invalid',
        '2026-03-01T00:00:00Z',
        '2026-04-01T00:00:00Z'
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid wallet address');
    });

    it('should reject invalid date format', () => {
      const result = validateAttributionRequest(
        'GD5XQ2Z7WLOLF5SKDJU5LJY45JFIOE2M5M2Y6QPEXGA5RYKQZTUKY2U',
        'invalid-date',
        '2026-04-01T00:00:00Z'
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid date format');
    });

    it('should reject start time after end time', () => {
      const result = validateAttributionRequest(
        'GD5XQ2Z7WLOLF5SKDJU5LJY45JFIOE2M5M2Y6QPEXGA5RYKQZTUKY2U',
        '2026-04-01T00:00:00Z',
        '2026-03-01T00:00:00Z'
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Start time must be before end time');
    });

    it('should reject future end time', () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const result = validateAttributionRequest(
        'GD5XQ2Z7WLOLF5SKDJU5LJY45JFIOE2M5M2Y6QPEXGA5RYKQZTUKY2U',
        '2026-03-01T00:00:00Z',
        futureDate
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('End time cannot be in the future');
    });

    it('should reject time window exceeding 1 year', () => {
      const result = validateAttributionRequest(
        'GD5XQ2Z7WLOLF5SKDJU5LJY45JFIOE2M5M2Y6QPEXGA5RYKQZTUKY2U',
        '2025-01-01T00:00:00Z',
        '2026-04-01T00:00:00Z'
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Time window cannot exceed 1 year');
    });
  });

  describe('PortfolioAttributionEngine', () => {
    it('should create engine with default config', () => {
      expect(engine).toBeInstanceOf(PortfolioAttributionEngine);
      
      const config = engine.getConfig();
      expect(config.minConfidenceThreshold).toBe(0.6);
      expect(config.maxDataGapDays).toBe(7);
      expect(config.requireMinDecisions).toBe(3);
    });

    it('should create engine with custom config', () => {
      const customEngine = new PortfolioAttributionEngine({
        minConfidenceThreshold: 0.8,
        maxDataGapDays: 14,
      });

      const config = customEngine.getConfig();
      expect(config.minConfidenceThreshold).toBe(0.8);
      expect(config.maxDataGapDays).toBe(14);
      expect(config.requireMinDecisions).toBe(3); // Should keep default
    });

    it('should update configuration', () => {
      engine.updateConfig({
        minConfidenceThreshold: 0.9,
        requireMinDecisions: 5,
      });

      const config = engine.getConfig();
      expect(config.minConfidenceThreshold).toBe(0.9);
      expect(config.requireMinDecisions).toBe(5);
      expect(config.maxDataGapDays).toBe(7); // Should keep previous value
    });

    describe('calculateAttributionReport', () => {
      const walletAddress = 'GD5XQ2Z7WLOLF5SKDJU5LJY45JFIOE2M5M2Y6QPEXGA5RYKQZTUKY2U';
      const startTime = '2026-03-01T00:00:00Z';
      const endTime = '2026-04-01T00:00:00Z';

      it('should generate attribution report successfully', async () => {
        const report = await engine.generateAttributionReport(walletAddress, startTime, endTime);

        expect(report).toHaveProperty('walletAddress', walletAddress);
        expect(report).toHaveProperty('timeWindow');
        expect(report).toHaveProperty('attributionBreakdown');
        expect(report).toHaveProperty('totalReturn');
        expect(report).toHaveProperty('totalDeposited');
        expect(report).toHaveProperty('dataCompleteness');
        expect(report).toHaveProperty('generatedAt');

        expect(report.timeWindow.start).toBe(startTime);
        expect(report.timeWindow.end).toBe(endTime);
        expect(Array.isArray(report.attributionBreakdown)).toBe(true);
        expect(typeof report.totalReturn).toBe('number');
        expect(typeof report.totalDeposited).toBe('number');
        expect(typeof report.dataCompleteness).toBe('number');
      });

      it('should group decisions by type', async () => {
        const report = await engine.generateAttributionReport(walletAddress, startTime, endTime);

        const decisionTypes = report.attributionBreakdown.map(b => b.decisionType);
        expect(decisionTypes).toContain('initial_routing');
        expect(decisionTypes).toContain('rotation');
        expect(decisionTypes).toContain('incentive_capture');
        expect(decisionTypes).toContain('hold');
      });

      it('should calculate percentages that sum to 100', async () => {
        const report = await engine.generateAttributionReport(walletAddress, startTime, endTime);

        const totalPercentage = report.attributionBreakdown.reduce((sum, b) => sum + b.percentage, 0);
        expect(totalPercentage).toBeCloseTo(100, 2);
      });

      it('should include confidence scores', async () => {
        const report = await engine.generateAttributionReport(walletAddress, startTime, endTime);

        report.attributionBreakdown.forEach(breakdown => {
          expect(breakdown.confidence).toBeGreaterThanOrEqual(0);
          expect(breakdown.confidence).toBeLessThanOrEqual(1);
        });
      });

      it('should assess data completeness', async () => {
        const report = await engine.generateAttributionReport(walletAddress, startTime, endTime);

        expect(report.dataCompleteness).toBeGreaterThanOrEqual(0);
        expect(report.dataCompleteness).toBeLessThanOrEqual(1);
      });
    });

    describe('calculateContribution', () => {
      it('should calculate contribution based on amount, APY, and duration', () => {
        const decisions = [
          {
            id: '1',
            type: 'initial_routing' as const,
            timestamp: '2026-03-20T10:30:00Z',
            protocol: 'Blend',
            amount: 1000,
            expectedApy: 6.5,
            actualApy: 6.8,
            duration: 30,
            confidence: 0.85,
          }
        ];

        // Access private method through reflection for testing
        const contribution = (engine as unknown as { calculateContribution: (decisions: unknown[]) => number }).calculateContribution(decisions);
        
        expect(contribution).toBeGreaterThan(0);
        expect(typeof contribution).toBe('number');
      });

      it('should apply confidence weighting', () => {
        const decisionsHigh = [
          {
            id: '1',
            type: 'initial_routing' as const,
            timestamp: '2026-03-20T10:30:00Z',
            protocol: 'Blend',
            amount: 1000,
            expectedApy: 6.5,
            actualApy: 6.5,
            duration: 30,
            confidence: 1.0,
          }
        ];

        const decisionsLow = [
          {
            id: '1',
            type: 'initial_routing' as const,
            timestamp: '2026-03-20T10:30:00Z',
            protocol: 'Blend',
            amount: 1000,
            expectedApy: 6.5,
            actualApy: 6.5,
            duration: 30,
            confidence: 0.5,
          }
        ];

        const contributionHigh = (engine as unknown as { calculateContribution: (decisions: unknown[]) => number }).calculateContribution(decisionsHigh);
        const contributionLow = (engine as unknown as { calculateContribution: (decisions: unknown[]) => number }).calculateContribution(decisionsLow);

        expect(contributionHigh).toBeGreaterThan(contributionLow);
      });
    });

    describe('edge cases', () => {
      it('should handle empty decisions array', async () => {
        // Mock empty decisions
        jest.spyOn(engine as unknown as { fetchStrategyDecisions: () => Promise<unknown[]> }, 'fetchStrategyDecisions').mockResolvedValue([]);

        const report = await engine.generateAttributionReport(
          'GD5XQ2Z7WLOLF5SKDJU5LJY45JFIOE2M5M2Y6QPEXGA5RYKQZTUKY2U',
          '2026-03-01T00:00:00Z',
          '2026-04-01T00:00:00Z'
        );

        expect(report.attributionBreakdown).toHaveLength(0);
        expect(report.totalReturn).toBe(0);
        expect(report.totalDeposited).toBe(0);
      });

      it('should handle decisions with missing actual APY', async () => {
        const decisionsWithMissingApy = [
          {
            id: '1',
            type: 'initial_routing' as const,
            timestamp: '2026-03-20T10:30:00Z',
            protocol: 'Blend',
            amount: 1000,
            expectedApy: 6.5,
            // actualApy missing
            duration: 30,
            confidence: 0.85,
          }
        ];

        jest.spyOn(engine as unknown as { fetchStrategyDecisions: () => Promise<unknown[]> }, 'fetchStrategyDecisions').mockResolvedValue(decisionsWithMissingApy);

        const report = await engine.generateAttributionReport(
          'GD5XQ2Z7WLOLF5SKDJU5LJY45JFIOE2M5M2Y6QPEXGA5RYKQZTUKY2U',
          '2026-03-01T00:00:00Z',
          '2026-04-01T00:00:00Z'
        );

        expect(report.attributionBreakdown).toHaveLength(1);
        expect(report.totalReturn).toBeGreaterThan(0);
      });
    });
  });

  describe('formatAttributionReport', () => {
    it('should format report with rounded values', () => {
      const mockReport = {
        walletAddress: 'GD5XQ2Z7WLOLF5SKDJU5LJY45JFIOE2M5M2Y6QPEXGA5RYKQZTUKY2U',
        totalReturn: 123.456789,
        totalDeposited: 1000.123456,
        attributionBreakdown: [
          {
            decisionType: 'initial_routing',
            contribution: 50.123456,
            percentage: 40.123456,
            apyImpact: 6.123456,
            decisions: [],
            confidence: 0.856789,
          }
        ],
        timeWindow: {
          start: '2026-03-01T00:00:00Z',
          end: '2026-04-01T00:00:00Z',
        },
        generatedAt: '2026-04-01T12:00:00Z',
        dataCompleteness: 0.856789,
      };

      const formatted = formatAttributionReport(mockReport);

      expect(formatted.totalReturn).toBe(123.46);
      expect(formatted.totalDeposited).toBe(1000.12);
      expect(formatted.dataCompleteness).toBe(0.86);
      
      const breakdown = formatted.attributionBreakdown[0];
      expect(breakdown.contribution).toBe(50.12);
      expect(breakdown.percentage).toBe(40.12);
      expect(breakdown.apyImpact).toBe(6.12);
      expect(breakdown.confidence).toBe(0.86);
    });
  });

  describe('singleton instance', () => {
    it('should export singleton instance', () => {
      expect(portfolioAttributionEngine).toBeInstanceOf(PortfolioAttributionEngine);
    });

    it('should maintain configuration across imports', () => {
      portfolioAttributionEngine.updateConfig({ minConfidenceThreshold: 0.95 });
      
      const config = portfolioAttributionEngine.getConfig();
      expect(config.minConfidenceThreshold).toBe(0.95);
    });
  });
});
