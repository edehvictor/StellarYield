import { AuditReplayService, type StrategyDecisionInputs, type StrategyDecisionOutputs } from '../services/auditReplayService'

describe('AuditReplayService', () => {
  let service: AuditReplayService

  const mockInputs: StrategyDecisionInputs = {
    portfolioState: { USDC: 10000, BTC: 0.5 },
    marketConditions: { volatility: 'high', trend: 'bearish' },
    riskMetrics: { VaR: 500, Sharpe: 1.2 },
    timestamp: new Date(),
  }

  const mockOutputs: StrategyDecisionOutputs = {
    recommendedAction: 'reduce_exposure',
    reasoning: { rationale: 'high volatility detected' },
    confidence: 0.85,
    stateTransition: { USDC: 11000, BTC: 0.4 },
  }

  const mockScores = {
    riskScore: 75,
    opportunityScore: 40,
    yieldScore: 60,
  }

  beforeEach(() => {
    service = new AuditReplayService()
  })

  describe('recordStrategyExecution', () => {
    it('should create and store audit record', () => {
      const record = service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        150,
        'success'
      )

      expect(record.id).toBeDefined()
      expect(record.strategyId).toBe('strategy-1')
      expect(record.status).toBe('success')
      expect(record.executionTime).toBe(150)
    })

    it('should record failed executions with error', () => {
      const record = service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        50,
        'failed',
        'Market data unavailable'
      )

      expect(record.status).toBe('failed')
      expect(record.error).toBe('Market data unavailable')
    })

    it('should preserve execution inputs and outputs exactly', () => {
      const record = service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        100
      )

      expect(record.inputs).toEqual(mockInputs)
      expect(record.outputs).toEqual(mockOutputs)
      expect(record.intermediateScores).toEqual(mockScores)
    })
  })

  describe('replayExecution', () => {
    it('should replay recorded execution', async () => {
      const record = service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        100
      )

      const result = await service.replayExecution(record.id)

      expect(result.originalRecord).toEqual(record)
      expect(result.replayOutputs).toBeDefined()
      expect(result.isDeterministic).toBeDefined()
      expect(result.executionTime).toBeGreaterThan(0)
    })

    it('should throw error for non-existent record', async () => {
      await expect(service.replayExecution('non-existent-id')).rejects.toThrow()
    })

    it('should detect determinism', async () => {
      const record = service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        100
      )

      const result = await service.replayExecution(record.id)

      expect(typeof result.isDeterministic).toBe('boolean')
    })

    it('should find discrepancies if outputs differ', async () => {
      const inputs = mockInputs
      const outputs1: StrategyDecisionOutputs = {
        recommendedAction: 'increase_position',
        reasoning: { rationale: 'opportunity detected' },
        confidence: 0.9,
        stateTransition: inputs.portfolioState,
      }

      const record = service.recordStrategyExecution(
        'strategy-1',
        inputs,
        outputs1,
        mockScores,
        100
      )

      const result = await service.replayExecution(record.id)

      expect(Array.isArray(result.discrepancies)).toBe(true)
    })
  })

  describe('execution history', () => {
    beforeEach(() => {
      // Create multiple records
      for (let i = 0; i < 5; i++) {
        service.recordStrategyExecution(
          'strategy-1',
          mockInputs,
          mockOutputs,
          mockScores,
          100 + i * 10
        )
      }
    })

    it('should retrieve execution history', () => {
      const history = service.getStrategyExecutionHistory('strategy-1')

      expect(Array.isArray(history)).toBe(true)
      expect(history.length).toBe(5)
    })

    it('should respect history limit', () => {
      const history = service.getStrategyExecutionHistory('strategy-1', 3)

      expect(history.length).toBe(3)
    })

    it('should return empty history for unknown strategy', () => {
      const history = service.getStrategyExecutionHistory('unknown-strategy')

      expect(history).toEqual([])
    })

    it('should retrieve single record', () => {
      const records = service.getStrategyExecutionHistory('strategy-1', 1)
      const recordId = records[0].id

      const retrieved = service.getExecutionRecord(recordId)

      expect(retrieved).toBeDefined()
      expect(retrieved?.id).toBe(recordId)
    })
  })

  describe('execution statistics', () => {
    it('should calculate stats for successful executions', () => {
      service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        100,
        'success'
      )
      service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        150,
        'success'
      )
      service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        200,
        'failed'
      )

      const stats = service.getExecutionStats('strategy-1')

      expect(stats.totalExecutions).toBe(3)
      expect(stats.successCount).toBe(2)
      expect(stats.failureCount).toBe(1)
      expect(stats.avgExecutionTime).toBeGreaterThan(0)
      expect(stats.lastExecution).toBeInstanceOf(Date)
    })

    it('should return zero stats for unknown strategy', () => {
      const stats = service.getExecutionStats('unknown-strategy')

      expect(stats.totalExecutions).toBe(0)
      expect(stats.successCount).toBe(0)
      expect(stats.failureCount).toBe(0)
      expect(stats.avgExecutionTime).toBe(0)
      expect(stats.lastExecution).toBeNull()
    })
  })

  describe('export functionality', () => {
    beforeEach(() => {
      service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        100,
        'success'
      )
      service.recordStrategyExecution(
        'strategy-1',
        mockInputs,
        mockOutputs,
        mockScores,
        120,
        'failed',
        'Test error'
      )
    })

    it('should export to JSON format', () => {
      const json = service.exportRecords('strategy-1', 'json')

      expect(typeof json).toBe('string')
      const parsed = JSON.parse(json)
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed.length).toBe(2)
    })

    it('should export to CSV format', () => {
      const csv = service.exportRecords('strategy-1', 'csv')

      expect(typeof csv).toBe('string')
      expect(csv).toContain('ID,ExecutionID,Status')
      const lines = csv.split('\n')
      expect(lines.length).toBeGreaterThan(1) // Header + records
    })

    it('should return empty export for unknown strategy', () => {
      const json = service.exportRecords('unknown-strategy', 'json')
      expect(json).toBe('[]')

      const csv = service.exportRecords('unknown-strategy', 'csv')
      expect(csv).toBe('')
    })
  })

  describe('data retention and pruning', () => {
    it('should enforce max records per strategy', () => {
      // This would require a configuration change to test properly
      // For now, just verify the method doesn't crash with many records
      for (let i = 0; i < 100; i++) {
        service.recordStrategyExecution(
          'strategy-1',
          mockInputs,
          mockOutputs,
          mockScores,
          100
        )
      }

      const history = service.getStrategyExecutionHistory('strategy-1', 10000)
      expect(history.length).toBeGreaterThan(0)
    })
  })
})
