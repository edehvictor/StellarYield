export interface StrategyDecisionInputs {
  portfolioState: Record<string, number>
  marketConditions: Record<string, unknown>
  riskMetrics: Record<string, number>
  timestamp: Date
}

export interface StrategyDecisionOutputs {
  recommendedAction: string
  reasoning: Record<string, unknown>
  confidence: number
  stateTransition: Record<string, unknown>
}

export interface AuditRecord {
  id: string
  strategyId: string
  executionId: string
  inputs: StrategyDecisionInputs
  outputs: StrategyDecisionOutputs
  intermediateScores: Record<string, number>
  executedAt: Date
  executionTime: number // milliseconds
  status: 'success' | 'failed' | 'partial'
  error?: string
}

export interface ReplayResult {
  originalRecord: AuditRecord
  replayOutputs: StrategyDecisionOutputs
  isDeterministic: boolean
  discrepancies: string[]
  executionTime: number
}

const MAX_RECORDS_PER_STRATEGY = 10000
const RETENTION_DAYS = 90

export class AuditReplayService {
  private records: Map<string, AuditRecord[]> = new Map()
  private recordIndex: Map<string, AuditRecord> = new Map()

  recordStrategyExecution(
    strategyId: string,
    inputs: StrategyDecisionInputs,
    outputs: StrategyDecisionOutputs,
    intermediateScores: Record<string, number>,
    executionTime: number,
    status: 'success' | 'failed' | 'partial' = 'success',
    error?: string
  ): AuditRecord {
    const record: AuditRecord = {
      id: `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      strategyId,
      executionId: `exec-${Date.now()}`,
      inputs,
      outputs,
      intermediateScores,
      executedAt: new Date(),
      executionTime,
      status,
      error,
    }

    // Store in strategy-specific list
    if (!this.records.has(strategyId)) {
      this.records.set(strategyId, [])
    }

    const strategyRecords = this.records.get(strategyId)!
    strategyRecords.push(record)

    // Enforce size limit
    if (strategyRecords.length > MAX_RECORDS_PER_STRATEGY) {
      strategyRecords.shift() // Remove oldest
    }

    // Index for quick lookup
    this.recordIndex.set(record.id, record)

    // Enforce retention policy
    this.pruneOldRecords()

    return record
  }

  async replayExecution(recordId: string): Promise<ReplayResult> {
    const record = this.recordIndex.get(recordId)
    if (!record) {
      throw new Error(`Audit record not found: ${recordId}`)
    }

    const startTime = performance.now()

    try {
      // Simulate replaying the decision with same inputs
      const replayOutputs = await this.simulateStrategyDecision(
        record.inputs,
        record.intermediateScores
      )

      const executionTime = performance.now() - startTime
      const isDeterministic = this.compareOutputs(record.outputs, replayOutputs)
      const discrepancies = this.findDiscrepancies(record.outputs, replayOutputs)

      return {
        originalRecord: record,
        replayOutputs,
        isDeterministic,
        discrepancies,
        executionTime: Math.round(executionTime),
      }
    } catch (error) {
      throw new Error(`Replay failed: ${String(error)}`)
    }
  }

  private async simulateStrategyDecision(
    inputs: StrategyDecisionInputs,
    _scores: Record<string, number>
  ): Promise<StrategyDecisionOutputs> {
    // Simulate strategy decision logic with same inputs
    // In production, this would call the actual strategy algorithm
    await new Promise(resolve => setTimeout(resolve, 1))
    return {
      recommendedAction: 'hold',
      reasoning: { simulation: true, timestamp: new Date().toISOString() },
      confidence: 0.85,
      stateTransition: inputs.portfolioState,
    }
  }

  private compareOutputs(
    original: StrategyDecisionOutputs,
    replayed: StrategyDecisionOutputs
  ): boolean {
    // Deterministic if recommendations match exactly
    return (
      original.recommendedAction === replayed.recommendedAction &&
      Math.abs(original.confidence - replayed.confidence) < 0.01
    )
  }

  private findDiscrepancies(
    original: StrategyDecisionOutputs,
    replayed: StrategyDecisionOutputs
  ): string[] {
    const discrepancies: string[] = []

    if (original.recommendedAction !== replayed.recommendedAction) {
      discrepancies.push(
        `Action mismatch: ${original.recommendedAction} vs ${replayed.recommendedAction}`
      )
    }

    if (Math.abs(original.confidence - replayed.confidence) > 0.01) {
      discrepancies.push(
        `Confidence mismatch: ${original.confidence} vs ${replayed.confidence}`
      )
    }

    return discrepancies
  }

  getStrategyExecutionHistory(
    strategyId: string,
    limit: number = 100
  ): AuditRecord[] {
    const records = this.records.get(strategyId) || []
    return records.slice(-limit).reverse()
  }

  getExecutionRecord(recordId: string): AuditRecord | undefined {
    return this.recordIndex.get(recordId)
  }

  getExecutionStats(strategyId: string): {
    totalExecutions: number
    successCount: number
    failureCount: number
    avgExecutionTime: number
    lastExecution: Date | null
  } {
    const records = this.records.get(strategyId) || []

    if (records.length === 0) {
      return {
        totalExecutions: 0,
        successCount: 0,
        failureCount: 0,
        avgExecutionTime: 0,
        lastExecution: null,
      }
    }

    const successful = records.filter(r => r.status === 'success')
    const failed = records.filter(r => r.status === 'failed')
    const avgTime = records.reduce((sum, r) => sum + r.executionTime, 0) / records.length

    return {
      totalExecutions: records.length,
      successCount: successful.length,
      failureCount: failed.length,
      avgExecutionTime: Math.round(avgTime),
      lastExecution: records[records.length - 1]?.executedAt || null,
    }
  }

  private pruneOldRecords(): void {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

    for (const [strategyId, records] of this.records.entries()) {
      const filtered = records.filter(r => r.executedAt > cutoffDate)

      if (filtered.length !== records.length) {
        // Remove pruned records from index
        const removed = records.filter(r => r.executedAt <= cutoffDate)
        for (const record of removed) {
          this.recordIndex.delete(record.id)
        }
      }

      this.records.set(strategyId, filtered)
    }
  }

  exportRecords(
    strategyId: string,
    format: 'json' | 'csv' = 'json'
  ): string {
    const records = this.records.get(strategyId) || []

    if (format === 'json') {
      return JSON.stringify(records, null, 2)
    }

    // CSV format
    if (records.length === 0) return ''

    const headers = ['ID', 'ExecutionID', 'Status', 'ExecutedAt', 'ExecutionTime', 'Action']
    const rows = records.map(r => [
      r.id,
      r.executionId,
      r.status,
      r.executedAt.toISOString(),
      r.executionTime.toString(),
      r.outputs.recommendedAction,
    ])

    return [headers, ...rows].map(row => row.join(',')).join('\n')
  }
}

export function createAuditReplayService() {
  return new AuditReplayService()
}
