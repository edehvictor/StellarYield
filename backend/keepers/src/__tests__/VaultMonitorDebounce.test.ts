import {
  VaultMonitor,
  CdpState,
  checkAndSetAlertSuppression,
  DEFAULT_ALERT_SUPPRESSION_WINDOW_MS,
} from '../monitors/VaultMonitor';
import { Queue } from 'bullmq';
import { LiquidationJobData } from '../queues/types';
import { logger } from '../utils/logger';

// ── Shared in-memory Redis mock simulating two instances sharing a key store ──

class SharedMockRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string, mode?: string, duration?: number, flag?: string): Promise<string | null> {
    const now = Date.now();
    const existing = this.store.get(key);

    // If key exists and is not expired
    if (existing && existing.expiresAt > now) {
      if (flag === 'NX') {
        return null; // Key already exists, cannot set
      }
    }

    const ttlMs = mode === 'PX' ? (duration ?? 60000) : (duration ? duration * 1000 : Infinity);
    this.store.set(key, { value, expiresAt: now + ttlMs });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  clear(): void {
    this.store.clear();
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('VaultMonitor Alert Debouncing Across Instances (#1540)', () => {
  let sharedRedis: SharedMockRedis;
  let mockQueue1: jest.Mocked<Queue<LiquidationJobData>>;
  let mockQueue2: jest.Mocked<Queue<LiquidationJobData>>;
  let monitorInstance1: VaultMonitor;
  let monitorInstance2: VaultMonitor;

  const undercollateralizedCdp: CdpState = {
    accountAddress: 'GACCOUNT_DEBOUNCE_TEST',
    collateral: 100_000n,
    debtShares: 1_000n,
    crBps: 8500, // 85% CR (below 110% MCR)
  };

  beforeEach(() => {
    jest.useFakeTimers();
    sharedRedis = new SharedMockRedis();

    mockQueue1 = {
      add: jest.fn().mockResolvedValue({ id: 'job-instance-1' }),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Queue<LiquidationJobData>>;

    mockQueue2 = {
      add: jest.fn().mockResolvedValue({ id: 'job-instance-2' }),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Queue<LiquidationJobData>>;

    // Two monitor instances sharing the same redis store and target contract
    monitorInstance1 = new VaultMonitor(mockQueue1, 'CSTABLECOIN_CONTRACT', 'http://rpc.test', sharedRedis);
    monitorInstance2 = new VaultMonitor(mockQueue2, 'CSTABLECOIN_CONTRACT', 'http://rpc.test', sharedRedis);
  });

  afterEach(() => {
    monitorInstance1.stop();
    monitorInstance2.stop();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('checkAndSetAlertSuppression helper', () => {
    it('sets the suppression key on first emission and rejects duplicate within window', async () => {
      const key = 'alert:test:account1';
      const first = await checkAndSetAlertSuppression(sharedRedis, key, 30_000);
      expect(first).toBe(true);

      const second = await checkAndSetAlertSuppression(sharedRedis, key, 30_000);
      expect(second).toBe(false);
    });

    it('allows emission again after the suppression window expires', async () => {
      const key = 'alert:test:account2';
      const windowMs = 5000;

      const first = await checkAndSetAlertSuppression(sharedRedis, key, windowMs);
      expect(first).toBe(true);

      // Advance time past the window
      jest.advanceTimersByTime(5001);

      const second = await checkAndSetAlertSuppression(sharedRedis, key, windowMs);
      expect(second).toBe(true);
    });

    it('fails open if redis is undefined or does not support set', async () => {
      expect(await checkAndSetAlertSuppression(null, 'key')).toBe(true);
      expect(await checkAndSetAlertSuppression({}, 'key')).toBe(true);
    });
  });

  describe('Two simulated VaultMonitor instances', () => {
    it('Instance 1 emits the alert and Instance 2 suppresses the duplicate in the same window', async () => {
      const warnSpy = jest.spyOn(logger, 'warn');
      const debugSpy = jest.spyOn(logger, 'debug');

      // Instance 1 scans and detects undercollateralized CDP
      const emitted1 = await monitorInstance1.emitAlert(undercollateralizedCdp);
      expect(emitted1).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ accountAddress: undercollateralizedCdp.accountAddress }),
        '[VaultMonitor] Flagged account for liquidation',
      );

      // Instance 2 scans concurrently and detects the same undercollateralized CDP
      const emitted2 = await monitorInstance2.emitAlert(undercollateralizedCdp);
      expect(emitted2).toBe(false); // Suppressed!
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ accountAddress: undercollateralizedCdp.accountAddress }),
        '[VaultMonitor] Duplicate alert suppressed by shared debounce window',
      );

      warnSpy.mockRestore();
      debugSpy.mockRestore();
    });

    it('Instance 2 can emit an alert after the suppression window expires', async () => {
      const warnSpy = jest.spyOn(logger, 'warn');

      // Instance 1 emits in window 1
      const first = await monitorInstance1.emitAlert(undercollateralizedCdp, 60_000);
      expect(first).toBe(true);

      // Advance time past the 60s window
      jest.advanceTimersByTime(60_001);

      // Instance 2 scans in window 2 -> should emit successfully!
      const second = await monitorInstance2.emitAlert(undercollateralizedCdp, 60_000);
      expect(second).toBe(true);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      warnSpy.mockRestore();
    });

    it('alerts for different accounts are not suppressed by each other', async () => {
      const otherCdp: CdpState = {
        accountAddress: 'GDIFFERENT_ACCOUNT',
        collateral: 50_000n,
        debtShares: 500n,
        crBps: 8000,
      };

      const emit1 = await monitorInstance1.emitAlert(undercollateralizedCdp);
      const emit2 = await monitorInstance2.emitAlert(otherCdp);

      expect(emit1).toBe(true);
      expect(emit2).toBe(true);
    });

    it('enqueueForLiquidation calls emitAlert and debounces warnings across instances', async () => {
      const warnSpy = jest.spyOn(logger, 'warn');

      // Instance 1 enqueues
      await (monitorInstance1 as any).enqueueForLiquidation(undercollateralizedCdp);
      expect(mockQueue1.add).toHaveBeenCalledWith(
        `liquidate:${undercollateralizedCdp.accountAddress}`,
        expect.anything(),
        expect.anything(),
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Instance 2 enqueues same account -> BullMQ deduplicates job, debounce suppresses alert
      await (monitorInstance2 as any).enqueueForLiquidation(undercollateralizedCdp);
      expect(mockQueue2.add).toHaveBeenCalledWith(
        `liquidate:${undercollateralizedCdp.accountAddress}`,
        expect.anything(),
        expect.anything(),
      );
      // Warning still called only once!
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });
  });
});
