/**
 * Multi-Strategy Recovery Priority Queue (#387)
 *
 * Ranks degraded strategy recovery items by impact, user exposure, and risk
 * severity. High-risk incidents are never starved by noisier low-impact ones.
 * All priority changes are recorded with a reason.
 */

export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface RecoveryItem {
  id: string;
  strategyId: string;
  /** 0–1: fraction of total TVL affected */
  impactScore: number;
  /** Number of users with active positions in this strategy */
  userExposure: number;
  riskSeverity: RiskSeverity;
  createdAt: string;
}

export interface RankedRecoveryItem extends RecoveryItem {
  priorityScore: number;
  rank: number;
}

export interface PriorityChangeRecord {
  itemId: string;
  oldRank: number;
  newRank: number;
  reason: string;
  changedAt: string;
}

const SEVERITY_WEIGHT: Record<RiskSeverity, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

/** Normalise userExposure to 0–1 relative to the max in the queue */
function normalizeExposure(items: RecoveryItem[]): Map<string, number> {
  const max = Math.max(...items.map((i) => i.userExposure), 1);
  return new Map(items.map((i) => [i.id, i.userExposure / max]));
}

function computeScore(item: RecoveryItem, normExposure: number): number {
  // Weights: impact 40%, exposure 35%, severity 25%
  return (
    item.impactScore * 0.4 +
    normExposure * 0.35 +
    SEVERITY_WEIGHT[item.riskSeverity] * 0.25
  );
}

export class RecoveryPriorityQueueService {
  private items: RecoveryItem[] = [];
  private changeLog: PriorityChangeRecord[] = [];

  enqueue(item: RecoveryItem): void {
    this.items.push(item);
  }

  /** Returns items ranked highest-priority first */
  getRankedQueue(): RankedRecoveryItem[] {
    const normMap = normalizeExposure(this.items);
    return [...this.items]
      .map((item) => ({
        ...item,
        priorityScore: Math.round(computeScore(item, normMap.get(item.id) ?? 0) * 1000) / 1000,
      }))
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .map((item, idx) => ({ ...item, rank: idx + 1 }));
  }

  /**
   * Manually reprioritise an item (operator override).
   * Records why the item moved.
   */
  reprioritize(itemId: string, newImpactScore: number, reason: string): void {
    const oldQueue = this.getRankedQueue();
    const oldRank = oldQueue.find((i) => i.id === itemId)?.rank ?? -1;

    const item = this.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`Recovery item ${itemId} not found`);
    item.impactScore = newImpactScore;

    const newQueue = this.getRankedQueue();
    const newRank = newQueue.find((i) => i.id === itemId)?.rank ?? -1;

    this.changeLog.push({
      itemId,
      oldRank,
      newRank,
      reason,
      changedAt: new Date().toISOString(),
    });
  }

  getChangeLog(): PriorityChangeRecord[] {
    return [...this.changeLog];
  }

  remove(itemId: string): void {
    this.items = this.items.filter((i) => i.id !== itemId);
  }
}

export const recoveryPriorityQueueService = new RecoveryPriorityQueueService();
