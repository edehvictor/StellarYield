export interface YieldSnapshot {
  timestamp: Date
  apyBps: number
  tvlUsd: number
  volatilityPct: number
}

export type YieldRegime = 'stable' | 'high-volatility' | 'declining-yield' | 'incentive-spike'

export interface RegimeClassification {
  regime: YieldRegime
  confidence: number
  timeWindow: '24h' | '7d' | '30d'
  reasoning: string
  thresholds: RegimeThresholds
}

export interface RegimeThresholds {
  volatilityHigh: number
  volatilityLow: number
  apyDeclineRate: number
  incentiveThreshold: number
}

const DEFAULT_THRESHOLDS: RegimeThresholds = {
  volatilityHigh: 25, // 25% volatility = high volatility
  volatilityLow: 5, // < 5% volatility = stable
  apyDeclineRate: 10, // > 10% APY decline = declining
  incentiveThreshold: 50, // > 50 bps incentive increase = spike
}

export class YieldRegimeService {
  constructor(private thresholds: RegimeThresholds = DEFAULT_THRESHOLDS) {}

  classifyRegime(snapshots: YieldSnapshot[], timeWindow: '24h' | '7d' | '30d' = '7d'): RegimeClassification {
    if (snapshots.length === 0) {
      return this.createUnknownRegime(timeWindow)
    }

    const sortedSnapshots = [...snapshots].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    const avgVolatility = this.calculateAverageVolatility(sortedSnapshots)
    const apyTrend = this.calculateApyTrend(sortedSnapshots)
    const incentiveChange = this.calculateIncentiveChange(sortedSnapshots)

    let regime: YieldRegime = 'stable'
    let confidence = 0.5
    let reasoning = ''

    // Classification logic
    if (avgVolatility > this.thresholds.volatilityHigh) {
      regime = 'high-volatility'
      confidence = Math.min(1, avgVolatility / 100)
      reasoning = `High volatility detected: ${avgVolatility.toFixed(2)}%`
    } else if (apyTrend < -this.thresholds.apyDeclineRate) {
      regime = 'declining-yield'
      confidence = Math.min(1, Math.abs(apyTrend) / 100)
      reasoning = `APY decline detected: ${apyTrend.toFixed(2)}% over ${timeWindow}`
    } else if (incentiveChange > this.thresholds.incentiveThreshold) {
      regime = 'incentive-spike'
      confidence = Math.min(1, incentiveChange / 500)
      reasoning = `Incentive spike detected: +${incentiveChange.toFixed(2)} bps`
    } else if (avgVolatility < this.thresholds.volatilityLow && apyTrend > -5) {
      regime = 'stable'
      confidence = Math.min(1, Math.max(0, (this.thresholds.volatilityLow - avgVolatility) / this.thresholds.volatilityLow) * 0.8)
      reasoning = `Stable regime: volatility ${avgVolatility.toFixed(2)}%, APY trend ${apyTrend.toFixed(2)}%`
    }

    return {
      regime,
      confidence: Math.max(0, Math.min(1, confidence)),
      timeWindow,
      reasoning,
      thresholds: this.thresholds,
    }
  }

  private calculateAverageVolatility(snapshots: YieldSnapshot[]): number {
    if (snapshots.length === 0) return 0
    const sum = snapshots.reduce((acc, s) => acc + s.volatilityPct, 0)
    return sum / snapshots.length
  }

  private calculateApyTrend(snapshots: YieldSnapshot[]): number {
    if (snapshots.length < 2) return 0

    const first = snapshots[0]
    const last = snapshots[snapshots.length - 1]

    const apyChangePercent = ((last.apyBps - first.apyBps) / first.apyBps) * 100
    return apyChangePercent
  }

  private calculateIncentiveChange(snapshots: YieldSnapshot[]): number {
    if (snapshots.length < 2) return 0

    // Incentive change approximated by largest single APY jump
    let maxJump = 0
    for (let i = 1; i < snapshots.length; i++) {
      const jump = Math.abs(snapshots[i].apyBps - snapshots[i - 1].apyBps)
      maxJump = Math.max(maxJump, jump)
    }

    return maxJump
  }

  private createUnknownRegime(timeWindow: '24h' | '7d' | '30d'): RegimeClassification {
    return {
      regime: 'stable',
      confidence: 0,
      timeWindow,
      reasoning: 'Insufficient data for classification',
      thresholds: this.thresholds,
    }
  }

  classifyMultiWindow(snapshots: YieldSnapshot[]): Record<'24h' | '7d' | '30d', RegimeClassification> {
    const now = new Date()
    const day = 24 * 60 * 60 * 1000

    const snapshots24h = snapshots.filter(s => now.getTime() - s.timestamp.getTime() <= day)
    const snapshots7d = snapshots.filter(s => now.getTime() - s.timestamp.getTime() <= 7 * day)
    const snapshots30d = snapshots.filter(s => now.getTime() - s.timestamp.getTime() <= 30 * day)

    return {
      '24h': this.classifyRegime(snapshots24h, '24h'),
      '7d': this.classifyRegime(snapshots7d, '7d'),
      '30d': this.classifyRegime(snapshots30d, '30d'),
    }
  }

  updateThresholds(newThresholds: Partial<RegimeThresholds>): void {
    Object.assign(this.thresholds, newThresholds)
  }

  getThresholds(): RegimeThresholds {
    return { ...this.thresholds }
  }
}

export function createYieldRegimeService(thresholds?: RegimeThresholds) {
  return new YieldRegimeService(thresholds)
}
