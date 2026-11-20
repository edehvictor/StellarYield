import { logger } from '../utils/logger';

export interface JobOwnership {
  jobId: string;
  workerId: string;
  claimedAt: number;
  heartbeatAt: number;
}

export interface HandoffRecord {
  jobId: string;
  fromWorkerId: string | null;
  toWorkerId: string;
  reason: 'expired' | 'restart' | 'normal';
  timestamp: number;
}

const DEFAULT_HEARTBEAT_TTL_MS = 30_000;

export class WorkerOwnershipRegistry {
  private readonly ownerships = new Map<string, JobOwnership>();
  private readonly handoffLog: HandoffRecord[] = [];
  private readonly heartbeatTtlMs: number;

  constructor(heartbeatTtlMs: number = DEFAULT_HEARTBEAT_TTL_MS) {
    this.heartbeatTtlMs = heartbeatTtlMs;
  }

  claim(jobId: string, workerId: string): boolean {
    const existing = this.ownerships.get(jobId);

    if (existing && existing.workerId === workerId) {
      existing.heartbeatAt = Date.now();
      return true;
    }

    if (existing && !this.isExpired(existing)) {
      return false;
    }

    const now = Date.now();
    this.ownerships.set(jobId, {
      jobId,
      workerId,
      claimedAt: now,
      heartbeatAt: now,
    });

    this.handoffLog.push({
      jobId,
      fromWorkerId: existing?.workerId ?? null,
      toWorkerId: workerId,
      reason: existing ? 'expired' : 'normal',
      timestamp: now,
    });

    logger.info({ jobId, workerId }, '[Ownership] Job claimed');
    return true;
  }

  heartbeat(jobId: string, workerId: string): boolean {
    const ownership = this.ownerships.get(jobId);
    if (!ownership || ownership.workerId !== workerId) return false;
    ownership.heartbeatAt = Date.now();
    return true;
  }

  release(jobId: string, workerId: string): boolean {
    const ownership = this.ownerships.get(jobId);
    if (!ownership || ownership.workerId !== workerId) return false;
    this.ownerships.delete(jobId);
    logger.info({ jobId, workerId }, '[Ownership] Job released');
    return true;
  }

  isExpired(ownership: JobOwnership): boolean {
    return Date.now() - ownership.heartbeatAt > this.heartbeatTtlMs;
  }

  getOwner(jobId: string): JobOwnership | undefined {
    return this.ownerships.get(jobId);
  }

  getHandoffLog(): readonly HandoffRecord[] {
    return this.handoffLog;
  }

  cleanupExpired(): string[] {
    const expired: string[] = [];
    for (const [jobId, ownership] of this.ownerships.entries()) {
      if (this.isExpired(ownership)) {
        expired.push(jobId);
        this.ownerships.delete(jobId);
        logger.info(
          { jobId, workerId: ownership.workerId },
          '[Ownership] Expired ownership cleaned up',
        );
      }
    }
    return expired;
  }

  registerRestart(workerId: string, jobIds: string[]): void {
    const now = Date.now();
    for (const jobId of jobIds) {
      const existing = this.ownerships.get(jobId);
      this.ownerships.set(jobId, {
        jobId,
        workerId,
        claimedAt: now,
        heartbeatAt: now,
      });
      this.handoffLog.push({
        jobId,
        fromWorkerId: existing?.workerId ?? null,
        toWorkerId: workerId,
        reason: 'restart',
        timestamp: now,
      });
    }
    logger.info({ workerId, count: jobIds.length }, '[Ownership] Restart handoff registered');
  }

  size(): number {
    return this.ownerships.size;
  }
}
