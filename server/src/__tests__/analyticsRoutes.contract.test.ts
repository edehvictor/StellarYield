import request from 'supertest';
import { Express } from 'express';
import { AnalyticsMockDataGenerator, FIELD_VALIDATORS } from './fixtures/analyticsMockData';

// Mock the analytics services
jest.mock('../services', () => ({
  portfolioAttributionEngine: {
    generateAttributionReport: jest.fn(),
    updateConfig: jest.fn(),
    getConfig: jest.fn(),
    clearCache: jest.fn(),
  },
  protocolCompatibilityEngine: {
    runCompatibilityCheck: jest.fn(),
    checkProtocol: jest.fn(),
    updateConfig: jest.fn(),
    getConfig: jest.fn(),
  },
  strategyHealthEngine: {
    calculateHealthScore: jest.fn(),
    getHealthScores: jest.fn(),
    updateConfig: jest.fn(),
    getConfig: jest.fn(),
  },
  yieldReliabilityEngine: {
    calculateReliabilityScore: jest.fn(),
    getReliabilityScores: jest.fn(),
    getAllProviderIds: jest.fn(),
    compareProviders: jest.fn(),
    getProvidersForRecommendations: jest.fn(),
    updateConfig: jest.fn(),
    getConfig: jest.fn(),
  },
}));

jest.mock('../services/strategyStateTransitionAuditService', () => ({
  strategyStateTransitionAuditService: {
    getGraph: jest.fn(),
  },
}));

jest.mock('../services/recommendationStabilityService', () => ({
  generateRecommendationStabilityReport: jest.fn(),
}));

// Import after mocking
import { createApp } from '../app';
import {
  portfolioAttributionEngine,
  protocolCompatibilityEngine,
  strategyHealthEngine,
  yieldReliabilityEngine,
} from '../services';
import { strategyStateTransitionAuditService } from '../services/strategyStateTransitionAuditService';
import { generateRecommendationStabilityReport } from '../services/recommendationStabilityService';

describe('Analytics Routes Contract Tests', () => {
  let server: Express;

  beforeEach(() => {
    server = createApp();
    jest.clearAllMocks();
  });

  describe('Portfolio Attribution Routes', () => {
    describe('GET /api/analytics/attribution/:walletAddress', () => {
      const mockAttributionReport = AnalyticsMockDataGenerator.createAttributionReport('GTEST123');

      beforeEach(() => {
        (portfolioAttributionEngine.generateAttributionReport as jest.Mock).mockResolvedValue(mockAttributionReport);
      });

      it('should return 400 for missing query parameters', async () => {
        const response = await request(server)
          .get('/api/analytics/attribution/GTEST123')
          .expect(400);

        expect(response.body).toMatchObject({
          success: false,
          error: 'Missing required parameters: startTime and endTime',
          example: expect.stringContaining('/api/analytics/attribution/:walletAddress?startTime='),
        });
      });

      it('should return valid attribution report structure', async () => {
        const response = await request(server)
          .get('/api/analytics/attribution/GTEST123')
          .query({
            startTime: '2026-03-01T00:00:00Z',
            endTime: '2026-04-01T00:00:00Z',
          })
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            walletAddress: expect.any(String),
            totalReturn: expect.any(Number),
            totalDeposited: expect.any(Number),
            attributionBreakdown: expect.arrayContaining([
              expect.objectContaining({
                decisionType: expect.any(String),
                contribution: expect.any(Number),
                percentage: expect.any(Number),
                apyImpact: expect.any(Number),
                decisions: expect.any(Array),
                confidence: expect.any(Number),
              }),
            ]),
            timeWindow: expect.objectContaining({
              start: expect.any(String),
              end: expect.any(String),
            }),
            generatedAt: expect.any(String),
            dataCompleteness: expect.any(Number),
            formattedDate: expect.any(String),
            totalAttribution: expect.any(Number),
          },
        });
      });

      it('should validate attribution report field types', async () => {
        const response = await request(server)
          .get('/api/analytics/attribution/GTEST123')
          .query({
            startTime: '2026-03-01T00:00:00Z',
            endTime: '2026-04-01T00:00:00Z',
          })
          .expect(200);

        const { data } = response.body;
        
        // Validate core fields
        expect(FIELD_VALIDATORS.nonEmptyString(data.walletAddress)).toBe(true);
        expect(FIELD_VALIDATORS.positiveNumber(data.totalReturn)).toBe(true);
        expect(FIELD_VALIDATORS.positiveNumber(data.totalDeposited)).toBe(true);
        expect(FIELD_VALIDATORS.percentage(data.dataCompleteness * 100)).toBe(true);
        expect(FIELD_VALIDATORS.timestamp(data.generatedAt)).toBe(true);
        
        // Validate attribution breakdown structure
        expect(Array.isArray(data.attributionBreakdown)).toBe(true);
        if (data.attributionBreakdown.length > 0) {
          const breakdown = data.attributionBreakdown[0];
          expect(FIELD_VALIDATORS.nonEmptyString(breakdown.decisionType)).toBe(true);
          expect(FIELD_VALIDATORS.positiveNumber(breakdown.contribution)).toBe(true);
          expect(FIELD_VALIDATORS.percentage(breakdown.percentage)).toBe(true);
          expect(typeof breakdown.confidence === 'number' && breakdown.confidence >= 0 && breakdown.confidence <= 1).toBe(true);
        }
      });

      it('should handle service unavailable errors', async () => {
        (portfolioAttributionEngine.generateAttributionReport as jest.Mock).mockRejectedValue(
          new Error('Service unavailable')
        );

        const response = await request(server)
          .get('/api/analytics/attribution/GTEST123')
          .query({
            startTime: '2026-03-01T00:00:00Z',
            endTime: '2026-04-01T00:00:00Z',
          })
          .expect(500);

        expect(response.body).toMatchObject({
          error: 'Failed to generate attribution report',
          message: 'Service unavailable',
        });
      });
    });

    describe('POST /api/analytics/attribution/config', () => {
      it('should update configuration successfully', async () => {
        const mockConfig = { threshold: 0.05, windowDays: 30 };
        (portfolioAttributionEngine.updateConfig as jest.Mock).mockImplementation(() => {});
        (portfolioAttributionEngine.getConfig as jest.Mock).mockReturnValue(mockConfig);

        const response = await request(server)
          .post('/api/analytics/attribution/config')
          .send(mockConfig)
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          message: 'Attribution configuration updated',
          config: mockConfig,
        });
      });
    });

    describe('DELETE /api/analytics/attribution/cache/:walletAddress', () => {
      it('should clear cache successfully', async () => {
        (portfolioAttributionEngine.clearCache as jest.Mock).mockImplementation(() => {});

        const response = await request(server)
          .delete('/api/analytics/attribution/cache/GTEST123')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          message: 'Attribution cache cleared for GTEST123',
        });
      });
    });
  });

  describe('Protocol Compatibility Routes', () => {
    const mockCompatibilityReport = AnalyticsMockDataGenerator.createCompatibilityReport();

    describe('GET /api/analytics/compatibility', () => {
      beforeEach(() => {
        (protocolCompatibilityEngine.runCompatibilityCheck as jest.Mock).mockResolvedValue(mockCompatibilityReport);
      });

      it('should return valid compatibility report structure', async () => {
        const response = await request(server)
          .get('/api/analytics/compatibility')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            protocols: expect.arrayContaining([
              expect.objectContaining({
                protocolName: expect.any(String),
                status: expect.any(String),
                criticalIssues: expect.any(Number),
              }),
            ]),
            issues: expect.any(Array),
            formattedDate: expect.any(String),
            criticalIssues: expect.any(Array),
          },
        });
      });
    });

    describe('GET /api/analytics/compatibility/:protocolName', () => {
      it('should return protocol-specific status', async () => {
        const mockStatus = {
          protocolName: 'Blend',
          status: 'compatible',
          lastChecked: '2026-05-26T12:00:00Z',
        };

        (protocolCompatibilityEngine.checkProtocol as jest.Mock).mockResolvedValue(mockStatus);

        const response = await request(server)
          .get('/api/analytics/compatibility/Blend')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: expect.objectContaining({
            protocolName: expect.any(String),
            status: expect.any(String),
          }),
        });
      });
    });

    describe('GET /api/analytics/compatibility/safe/:protocolName', () => {
      beforeEach(() => {
        (protocolCompatibilityEngine.runCompatibilityCheck as jest.Mock).mockResolvedValue(mockCompatibilityReport);
      });

      it('should return safety status for protocol', async () => {
        const response = await request(server)
          .get('/api/analytics/compatibility/safe/Blend')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            protocolName: 'Blend',
            isSafe: expect.any(Boolean),
            status: expect.any(String),
          },
        });
      });
    });
  });

  describe('Strategy Health Routes', () => {
    const mockHealthScore = AnalyticsMockDataGenerator.createHealthScore('strategy_1', 'Test Strategy');

    describe('GET /api/analytics/health/:strategyId', () => {
      beforeEach(() => {
        (strategyHealthEngine.calculateHealthScore as jest.Mock).mockResolvedValue(mockHealthScore);
      });

      it('should return valid health score structure', async () => {
        const response = await request(server)
          .get('/api/analytics/health/strategy_1')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            strategyId: expect.any(String),
            strategyName: expect.any(String),
            overallScore: expect.any(Number),
            metrics: expect.objectContaining({
              contractSafety: expect.any(Number),
              dataFreshness: expect.any(Number),
              providerUptime: expect.any(Number),
              liquidityConditions: expect.any(Number),
              executionOutcomes: expect.any(Number),
              volatilityIndex: expect.any(Number),
              errorRate: expect.any(Number),
              latency: expect.any(Number),
            }),
            status: expect.stringMatching(/^(healthy|degraded|critical|disabled)$/),
            signals: expect.any(Array),
            lastUpdated: expect.any(String),
            trend: expect.stringMatching(/^(improving|stable|declining)$/),
            recommendations: expect.any(Array),
            formattedDate: expect.any(String),
          },
        });
      });
    });

    describe('POST /api/analytics/health/batch', () => {
      beforeEach(() => {
        (strategyHealthEngine.getHealthScores as jest.Mock).mockResolvedValue([mockHealthScore]);
      });

      it('should return batch health scores', async () => {
        const response = await request(server)
          .post('/api/analytics/health/batch')
          .send({ strategyIds: ['strategy_1', 'strategy_2'] })
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: expect.arrayContaining([
            expect.objectContaining({
              strategyId: expect.any(String),
              overallScore: expect.any(Number),
              status: expect.any(String),
            }),
          ]),
        });
      });

      it('should return 400 for invalid request body', async () => {
        const response = await request(server)
          .post('/api/analytics/health/batch')
          .send({ strategyIds: 'invalid' })
          .expect(400);

        expect(response.body).toMatchObject({
          error: 'strategyIds must be a non-empty array',
        });
      });
    });

    describe('GET /api/analytics/health/alerts', () => {
      beforeEach(() => {
        (strategyHealthEngine.getHealthScores as jest.Mock).mockResolvedValue([
          { ...mockHealthScore, overallScore: 45 }, // Critical
          { ...mockHealthScore, overallScore: 85 }, // Healthy
        ]);
      });

      it('should return critical health alerts', async () => {
        const response = await request(server)
          .get('/api/analytics/health/alerts')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            alerts: expect.any(Array),
            criticalCount: expect.any(Number),
            totalStrategies: expect.any(Number),
          },
        });
      });
    });
  });

  describe('Yield Reliability Routes', () => {
    const mockReliabilityScore = AnalyticsMockDataGenerator.createReliabilityScore('provider_1', 'Test Provider');

    describe('GET /api/analytics/reliability/:providerId', () => {
      beforeEach(() => {
        (yieldReliabilityEngine.calculateReliabilityScore as jest.Mock).mockResolvedValue(mockReliabilityScore);
      });

      it('should return valid reliability score structure', async () => {
        const response = await request(server)
          .get('/api/analytics/reliability/provider_1')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            providerId: expect.any(String),
            providerName: expect.any(String),
            overallScore: expect.any(Number),
            status: expect.stringMatching(/^(reliable|moderate|unreliable)$/),
            formattedDate: expect.any(String),
          },
        });
      });
    });

    describe('POST /api/analytics/reliability/batch', () => {
      beforeEach(() => {
        (yieldReliabilityEngine.getReliabilityScores as jest.Mock).mockResolvedValue([mockReliabilityScore]);
      });

      it('should return batch reliability scores', async () => {
        const providers = [
          { id: 'provider_1', name: 'Provider 1', source: 'api' },
          { id: 'provider_2', name: 'Provider 2', source: 'api' },
        ];

        const response = await request(server)
          .post('/api/analytics/reliability/batch')
          .send({ providers })
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: expect.arrayContaining([
            expect.objectContaining({
              providerId: expect.any(String),
              overallScore: expect.any(Number),
              status: expect.any(String),
            }),
          ]),
        });
      });

      it('should return 400 for invalid request body', async () => {
        const response = await request(server)
          .post('/api/analytics/reliability/batch')
          .send({ providers: 'invalid' })
          .expect(400);

        expect(response.body).toMatchObject({
          error: 'providers must be a non-empty array',
        });
      });
    });

    describe('GET /api/analytics/reliability/compare', () => {
      beforeEach(() => {
        ((yieldReliabilityEngine as any).getAllProviderIds as jest.Mock).mockResolvedValue(['provider_1', 'provider_2']);
        (yieldReliabilityEngine.compareProviders as jest.Mock).mockResolvedValue({
          providers: [mockReliabilityScore],
          ranking: [{ providerId: 'provider_1', rank: 1, score: 88.5 }],
        });
      });

      it('should return provider comparison', async () => {
        const response = await request(server)
          .get('/api/analytics/reliability/compare')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: expect.objectContaining({
            providers: expect.any(Array),
            ranking: expect.any(Array),
          }),
        });
      });
    });

    describe('GET /api/analytics/reliability/recommendations', () => {
      beforeEach(() => {
        (yieldReliabilityEngine.getProvidersForRecommendations as jest.Mock).mockResolvedValue([
          { ...mockReliabilityScore, reliabilityScore: 88.5 },
        ]);
      });

      it('should return provider recommendations', async () => {
        const response = await request(server)
          .get('/api/analytics/reliability/recommendations')
          .query({ minReliability: 80 })
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            providers: expect.any(Array),
            minReliability: 80,
            totalProviders: expect.any(Number),
            selectedProviders: expect.any(Number),
          },
        });
      });
    });
  });

  describe('Combined Analytics Routes', () => {
    describe('GET /api/analytics/dashboard', () => {
      beforeEach(() => {
        (portfolioAttributionEngine.generateAttributionReport as jest.Mock).mockResolvedValue({
          walletAddress: 'GTEST123',
          totalReturn: 1250.50,
          breakdown: [],
        });
        (protocolCompatibilityEngine.runCompatibilityCheck as jest.Mock).mockResolvedValue({
          protocols: [],
          issues: [],
        });
        (strategyHealthEngine.getHealthScores as jest.Mock).mockResolvedValue([]);
        (yieldReliabilityEngine.getReliabilityScores as jest.Mock).mockResolvedValue([]);
      });

      it('should return comprehensive dashboard data structure', async () => {
        const response = await request(server)
          .get('/api/analytics/dashboard')
          .query({
            walletAddress: 'GTEST123',
            strategyIds: ['strategy_1'],
            providerIds: ['provider_1'],
          })
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            attribution: expect.any(Object),
            compatibility: expect.any(Object),
            healthScores: expect.any(Array),
            reliabilityScores: expect.any(Array),
            alerts: expect.any(Array),
            summary: expect.objectContaining({
              overallHealth: expect.any(String),
              criticalIssues: expect.any(Number),
              recommendations: expect.any(Array),
              lastUpdated: expect.any(String),
            }),
          },
        });
      });

      it('should handle empty state gracefully', async () => {
        const response = await request(server)
          .get('/api/analytics/dashboard')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            attribution: null,
            compatibility: expect.any(Object),
            healthScores: expect.any(Array),
            reliabilityScores: expect.any(Array),
            alerts: expect.any(Array),
            summary: expect.objectContaining({
              overallHealth: 'unknown',
              criticalIssues: expect.any(Number),
            }),
          },
        });
      });
    });
  });

  describe('Strategy State Transitions Route', () => {
    describe('GET /api/analytics/strategy-state-transitions/:strategyId', () => {
      const mockGraph = AnalyticsMockDataGenerator.createStateTransitionGraph('strategy_1');

      beforeEach(() => {
        (strategyStateTransitionAuditService.getGraph as jest.Mock).mockReturnValue(mockGraph);
      });

      it('should return strategy state transition graph', async () => {
        const response = await request(server)
          .get('/api/analytics/strategy-state-transitions/strategy_1')
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            strategyId: expect.any(String),
            transitions: expect.any(Array),
            totalTransitions: expect.any(Number),
            generatedAt: expect.any(String),
          },
        });
      });

      it('should respect limit parameter', async () => {
        await request(server)
          .get('/api/analytics/strategy-state-transitions/strategy_1')
          .query({ limit: 50 })
          .expect(200);

        expect(strategyStateTransitionAuditService.getGraph).toHaveBeenCalledWith('strategy_1', 50);
      });
    });
  });

  describe('Recommendation Stability Route', () => {
    describe('POST /api/analytics/recommendation-stability/compare', () => {
      const mockReport = AnalyticsMockDataGenerator.createRecommendationStabilityReport();

      beforeEach(() => {
        (generateRecommendationStabilityReport as jest.Mock).mockReturnValue(mockReport);
      });

      it('should return recommendation stability report', async () => {
        const requestBody = {
          before: [{ id: '1', recommendation: 'buy' }],
          after: [{ id: '1', recommendation: 'hold' }],
        };

        const response = await request(server)
          .post('/api/analytics/recommendation-stability/compare')
          .send(requestBody)
          .expect(200);

        expect(response.body).toMatchObject({
          success: true,
          data: {
            stability: expect.objectContaining({
              overallScore: expect.any(Number),
              changedRecommendations: expect.any(Number),
              totalRecommendations: expect.any(Number),
            }),
            differences: expect.any(Array),
            summary: expect.objectContaining({
              stable: expect.any(Boolean),
              riskLevel: expect.any(String),
            }),
          },
        });
      });

      it('should return 400 for invalid request body', async () => {
        const response = await request(server)
          .post('/api/analytics/recommendation-stability/compare')
          .send({ before: 'invalid' })
          .expect(400);

        expect(response.body).toMatchObject({
          success: false,
          error: expect.stringContaining('Missing or invalid request body'),
        });
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle service unavailable errors consistently', async () => {
      (portfolioAttributionEngine.generateAttributionReport as jest.Mock).mockRejectedValue(
        new Error('Service temporarily unavailable')
      );

      const response = await request(server)
        .get('/api/analytics/attribution/GTEST123')
        .query({
          startTime: '2026-03-01T00:00:00Z',
          endTime: '2026-04-01T00:00:00Z',
        })
        .expect(500);

      expect(response.body).toMatchObject({
        error: expect.any(String),
        message: expect.any(String),
      });
    });

    it('should handle unknown errors gracefully', async () => {
      (protocolCompatibilityEngine.runCompatibilityCheck as jest.Mock).mockRejectedValue(
        'Unknown error type'
      );

      const response = await request(server)
        .get('/api/analytics/compatibility')
        .expect(500);

      expect(response.body).toMatchObject({
        error: expect.any(String),
        message: 'Unknown error',
      });
    });
  });
});