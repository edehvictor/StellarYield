export interface StrategyCandidate {
  id: string;
  name: string;
  strategyType: string;
  expectedUpsidePct: number;
  confidenceScore: number;
  urgencyScore: number;
  resourceCost: number;
  createdAt: string;
}

export interface PrioritizedCandidate extends StrategyCandidate {
  priorityScore: number;
  rank: number;
  justification: string;
}

export interface QueueConfig {
  upsideWeight: number;
  confidenceWeight: number;
  urgencyWeight: number;
  maxQueueSize: number;
  starvationPreventionEnabled: boolean;
  starvationTimeToLiveMs: number;
  minPriorityToProcess: number;
}

export interface QueueState {
  totalEnqueued: number;
  totalProcessed: number;
  currentQueueSize: number;
  avgWaitTimeMs: number;
  starvationCount: number;
}

export interface ProcessingResult {
  candidateId: string;
  candidateName: string;
  priorityScore: number;
  approved: boolean;
  reason: string;
}

const DEFAULT_CONFIG: QueueConfig = {
  upsideWeight: 0.4,
  confidenceWeight: 0.35,
  urgencyWeight: 0.25,
  maxQueueSize: 100,
  starvationPreventionEnabled: true,
  starvationTimeToLiveMs: 300_000,
  minPriorityToProcess: 10,
};

const MIN_QUALITY_SCORE = 6;

export class StrategyCandidateQueueService {
  private config: QueueConfig;
  private candidates: StrategyCandidate[] = [];
  private processedIds: Set<string> = new Set();
  private enqueueTimestamps: Map<string, number> = new Map();
  private queueState: QueueState = {
    totalEnqueued: 0,
    totalProcessed: 0,
    currentQueueSize: 0,
    avgWaitTimeMs: 0,
    starvationCount: 0,
  };

  constructor(config: Partial<QueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  enqueue(candidate: StrategyCandidate): boolean {
    if (this.processedIds.has(candidate.id)) {
      return false;
    }

    if (this.candidates.some(c => c.id === candidate.id)) {
      return false;
    }

    if (this.candidates.length >= this.config.maxQueueSize) {
      const lowest = this.candidates.reduce((min, c) =>
        this.computePriorityScore(c) < this.computePriorityScore(min) ? c : min,
      );
      if (this.computePriorityScore(candidate) <= this.computePriorityScore(lowest)) {
        return false;
      }
      this.candidates = this.candidates.filter(c => c.id !== lowest.id);
    }

    this.candidates.push(candidate);
    this.enqueueTimestamps.set(candidate.id, Date.now());
    this.queueState.totalEnqueued++;
    this.queueState.currentQueueSize = this.candidates.length;

    this.recalculateQueueState();

    if (this.config.starvationPreventionEnabled) {
      this.applyStarvationBoost();
    }

    return true;
  }

  getPrioritizedQueue(): PrioritizedCandidate[] {
    if (this.config.starvationPreventionEnabled) {
      this.applyStarvationBoost();
    }

    const scored = this.candidates.map(candidate => {
      const priorityScore = this.computePriorityScore(candidate);
      return { candidate, priorityScore };
    });

    scored.sort((a, b) => b.priorityScore - a.priorityScore);

    return scored.map((item, idx) => ({
      ...item.candidate,
      priorityScore: Math.round(item.priorityScore * 100) / 100,
      rank: idx + 1,
      justification: this.buildJustification(item.candidate, item.priorityScore, idx),
    }));
  }

  nextForProcessing(): PrioritizedCandidate | null {
    const queue = this.getPrioritizedQueue();
    if (queue.length === 0) return null;

    const next = queue[0];

    if (next.priorityScore < this.config.minPriorityToProcess) {
      return null;
    }

    return next;
  }

  approve(candidateId: string): ProcessingResult {
    const candidate = this.candidates.find(c => c.id === candidateId);
    if (!candidate) {
      return {
        candidateId,
        candidateName: 'Unknown',
        priorityScore: 0,
        approved: false,
        reason: 'Candidate not found in queue',
      };
    }

    const priorityScore = this.computePriorityScore(candidate);

    if (priorityScore < this.config.minPriorityToProcess) {
      return {
        candidateId,
        candidateName: candidate.name,
        priorityScore: Math.round(priorityScore * 100) / 100,
        approved: false,
        reason: `Priority score ${Math.round(priorityScore)} below minimum threshold ${this.config.minPriorityToProcess}`,
      };
    }

    this.removeFromQueue(candidateId);
    this.processedIds.add(candidateId);
    this.queueState.totalProcessed++;

    return {
      candidateId,
      candidateName: candidate.name,
      priorityScore: Math.round(priorityScore * 100) / 100,
      approved: true,
      reason: 'Candidate approved for processing',
    };
  }

  reject(candidateId: string, reason: string): ProcessingResult {
    const candidate = this.candidates.find(c => c.id === candidateId);
    this.removeFromQueue(candidateId);
    this.processedIds.add(candidateId);

    return {
      candidateId,
      candidateName: candidate?.name ?? 'Unknown',
      priorityScore: candidate ? this.computePriorityScore(candidate) : 0,
      approved: false,
      reason,
    };
  }

  getQueueState(): QueueState {
    return { ...this.queueState };
  }

  getConfig(): QueueConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<QueueConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private computePriorityScore(candidate: StrategyCandidate): number {
    const upsideScore = candidate.expectedUpsidePct * this.config.upsideWeight;
    const confidenceScore = candidate.confidenceScore * this.config.confidenceWeight;
    const urgencyScore = candidate.urgencyScore * this.config.urgencyWeight;

    return upsideScore + confidenceScore + urgencyScore;
  }

  private buildJustification(candidate: StrategyCandidate, score: number, rank: number): string {
    const parts: string[] = [];

    if (candidate.expectedUpsidePct >= 20) {
      parts.push(`high upside (${candidate.expectedUpsidePct}%)`);
    }
    if (candidate.confidenceScore >= 80) {
      parts.push('strong confidence');
    }
    if (candidate.urgencyScore >= 70) {
      parts.push('urgent');
    }
    if (rank === 1) {
      parts.push('top ranked');
    }

    return parts.length > 0
      ? `Rank #${rank}: ${parts.join(', ')}`
      : `Rank #${rank}: standard priority`;
  }

  private applyStarvationBoost(): void {
    const now = Date.now();
    let boostedCount = 0;

    for (const candidate of this.candidates) {
      const enqueuedAt = this.enqueueTimestamps.get(candidate.id);
      if (!enqueuedAt) continue;

      const waitTime = now - enqueuedAt;
      if (waitTime > this.config.starvationTimeToLiveMs) {
        candidate.urgencyScore = candidate.urgencyScore * (1 + (waitTime / this.config.starvationTimeToLiveMs) * 0.5);
        boostedCount++;
      }
    }

    this.queueState.starvationCount = boostedCount;
  }

  private removeFromQueue(candidateId: string): void {
    this.candidates = this.candidates.filter(c => c.id !== candidateId);
    this.queueState.currentQueueSize = this.candidates.length;
    this.enqueueTimestamps.delete(candidateId);
  }

  private recalculateQueueState(): void {
    const now = Date.now();
    let totalWait = 0;
    let count = 0;

    for (const [, timestamp] of this.enqueueTimestamps) {
      totalWait += now - timestamp;
      count++;
    }

    this.queueState.avgWaitTimeMs = count > 0 ? totalWait / count : 0;
    this.queueState.currentQueueSize = this.candidates.length;
  }

  clear(): void {
    this.candidates = [];
    this.enqueueTimestamps.clear();
    this.queueState.currentQueueSize = 0;
  }

  isCandidateQualified(candidate: StrategyCandidate): boolean {
    const score = this.computePriorityScore(candidate);
    return score >= MIN_QUALITY_SCORE;
  }
}

export const strategyCandidateQueueService = new StrategyCandidateQueueService();
