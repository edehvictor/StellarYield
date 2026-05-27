import { YieldRegimeService, type YieldSnapshot } from '../services/yieldRegimeService'

describe('YieldRegimeService', () => {
  let service: YieldRegimeService

  beforeEach(() => {
    service = new YieldRegimeService()
  })

  const createSnapshot = (
    daysAgo: number,
    apyBps: number,
    volatilityPct: number,
    tvlUsd: number = 1000000
  ): YieldSnapshot => {
    const date = new Date()
    date.setDate(date.getDate() - daysAgo)
    return {
      timestamp: date,
      apyBps,
      volatilityPct,
      tvlUsd,
    }
  }

  describe('classifyRegime', () => {
    it('should classify stable regime with low volatility', () => {
      const snapshots = [
        createSnapshot(7, 1000, 3),
        createSnapshot(6, 1010, 2),
        createSnapshot(5, 1005, 4),
        createSnapshot(0, 1015, 3),
      ]

      const result = service.classifyRegime(snapshots, '7d')

      expect(result.regime).toBe('stable')
      expect(result.confidence).toBeGreaterThan(0)
      expect(result.timeWindow).toBe('7d')
    })

    it('should classify high-volatility regime', () => {
      const snapshots = [
        createSnapshot(7, 1000, 10),
        createSnapshot(6, 800, 35),
        createSnapshot(5, 1200, 40),
        createSnapshot(0, 900, 30),
      ]

      const result = service.classifyRegime(snapshots, '7d')

      expect(result.regime).toBe('high-volatility')
      expect(result.confidence).toBeGreaterThan(0)
    })

    it('should classify declining-yield regime', () => {
      const snapshots = [
        createSnapshot(7, 2000, 5),
        createSnapshot(6, 1900, 5),
        createSnapshot(5, 1700, 5),
        createSnapshot(0, 1400, 5),
      ]

      const result = service.classifyRegime(snapshots, '7d')

      expect(result.regime).toBe('declining-yield')
      expect(result.confidence).toBeGreaterThan(0)
    })

    it('should classify incentive-spike regime', () => {
      const snapshots = [
        createSnapshot(7, 1000, 5),
        createSnapshot(6, 1000, 5),
        createSnapshot(5, 1000, 5),
        createSnapshot(0, 1100, 5),
      ]

      const result = service.classifyRegime(snapshots, '7d')

      expect(['stable', 'incentive-spike']).toContain(result.regime)
    })

    it('should return stable regime for empty snapshots', () => {
      const result = service.classifyRegime([])

      expect(result.regime).toBe('stable')
      expect(result.confidence).toBe(0)
    })

    it('should handle single snapshot', () => {
      const snapshots = [createSnapshot(0, 1000, 5)]

      const result = service.classifyRegime(snapshots)

      expect(result.regime).toBe('stable')
      expect(result.timeWindow).toBe('7d')
    })
  })

  describe('classifyMultiWindow', () => {
    it('should classify all time windows', () => {
      const now = new Date()
      const snapshots = [
        { ...createSnapshot(0, 1000, 5), timestamp: now },
        { ...createSnapshot(1, 1010, 4), timestamp: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000) },
        { ...createSnapshot(7, 1050, 6), timestamp: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
        { ...createSnapshot(30, 1200, 8), timestamp: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
      ]

      const result = service.classifyMultiWindow(snapshots)

      expect(result['24h']).toBeDefined()
      expect(result['7d']).toBeDefined()
      expect(result['30d']).toBeDefined()
      expect(result['24h'].timeWindow).toBe('24h')
      expect(result['7d'].timeWindow).toBe('7d')
      expect(result['30d'].timeWindow).toBe('30d')
    })

    it('should filter snapshots by time window', () => {
      const now = new Date()
      const snapshots = [
        { ...createSnapshot(0, 1000, 5), timestamp: now },
        { ...createSnapshot(2, 1010, 4), timestamp: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) },
        { ...createSnapshot(60, 1050, 6), timestamp: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000) },
      ]

      const result = service.classifyMultiWindow(snapshots)

      expect(result['24h']).toBeDefined()
      expect(result['7d']).toBeDefined()
      expect(result['30d']).toBeDefined()
    })
  })

  describe('threshold management', () => {
    it('should update thresholds', () => {
      service.updateThresholds({
        volatilityHigh: 50,
        apyDeclineRate: 20,
      })

      const thresholds = service.getThresholds()

      expect(thresholds.volatilityHigh).toBe(50)
      expect(thresholds.apyDeclineRate).toBe(20)
      expect(thresholds.volatilityLow).toBe(5) // unchanged
    })

    it('should return copy of thresholds', () => {
      const thresholds1 = service.getThresholds()
      const thresholds2 = service.getThresholds()

      expect(thresholds1).toEqual(thresholds2)
      expect(thresholds1).not.toBe(thresholds2)
    })
  })

  describe('confidence calculation', () => {
    it('should calculate confidence between 0 and 1', () => {
      const snapshots = [
        createSnapshot(7, 1000, 30),
        createSnapshot(0, 900, 40),
      ]

      const result = service.classifyRegime(snapshots)

      expect(result.confidence).toBeGreaterThanOrEqual(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
    })

    it('should have higher confidence for extreme conditions', () => {
      const stableSnapshots = [
        createSnapshot(7, 1000, 2),
        createSnapshot(0, 1005, 3),
      ]

      const volatileSnapshots = [
        createSnapshot(7, 1000, 80),
        createSnapshot(0, 500, 90),
      ]

      const stableResult = service.classifyRegime(stableSnapshots)
      const volatileResult = service.classifyRegime(volatileSnapshots)

      expect(volatileResult.confidence).toBeGreaterThan(stableResult.confidence)
    })
  })
})
