import { Queue } from 'bullmq';
import {
  CompoundScheduler,
  evaluateNetYield,
  CompoundEconomics,
  CompoundEconomicsProvider,
} from '../monitors/CompoundScheduler';
import { CompoundJobData } from '../queues/types';
import { config } from '../config';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../utils/redis', () => ({
  getRedis: jest.fn().mockReturnValue({ status: 'ready', on: jest.fn() }),
}));

function makeMockQueue(): jest.Mocked<Queue<CompoundJobData>> {
  return {
    add: jest.fn().mockResolvedValue({ id: 'repeat-1' }),
    removeRepeatable: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Queue<CompoundJobData>>;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('evaluateNetYield (#1534)', () => {
  test('net yield equal to the threshold is still eligible', () => {
    const decision = evaluateNetYield(
      { expectedReward: '1000', estimatedFees: '400' },
      '600',
    );
    expect(decision.eligible).toBe(true);
    expect(decision.netYield).toBe('600');
    expect(decision.reason).toBe('NET_YIELD_OK');
  });

  test('net yield strictly below the threshold is skipped', () => {
    const decision = evaluateNetYield(
      { expectedReward: '1000', estimatedFees: '401' },
      '600',
    );
    expect(decision.eligible).toBe(false);
    expect(decision.netYield).toBe('599');
    expect(decision.reason).toBe('NET_YIELD_BELOW_THRESHOLD');
  });

  test('fees above reward produce a negative net yield and are skipped', () => {
    const decision = evaluateNetYield(
      { expectedReward: '500', estimatedFees: '700' },
      '0',
    );
    expect(decision.eligible).toBe(false);
    expect(decision.netYield).toBe('-200');
  });

  test('large stroop amounts are compared exactly (no float drift)', () => {
    const decision = evaluateNetYield(
      { expectedReward: '9223372036854775807', estimatedFees: '1' },
      '9223372036854775806',
    );
    expect(decision.eligible).toBe(true);
    expect(decision.netYield).toBe('9223372036854775806');
  });

  test('unavailable economics do not block compounding', () => {
    const decision = evaluateNetYield(null, '1000');
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe('ECONOMICS_UNAVAILABLE');
  });

  test('malformed amounts fall back to unblocked (ECONOMICS_UNAVAILABLE)', () => {
    const decision = evaluateNetYield(
      { expectedReward: 'not-a-number', estimatedFees: '1' },
      '100',
    );
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe('ECONOMICS_UNAVAILABLE');
  });
});

describe('CompoundScheduler minimum net-yield threshold (#1534)', () => {
  const VAULT = 'CVAULT_YIELD';

  let mockQueue: jest.Mocked<Queue<CompoundJobData>>;

  function makeScheduler(
    economics: CompoundEconomics | null,
    minNetYield = '600',
  ): CompoundScheduler {
    const provider: CompoundEconomicsProvider = jest.fn().mockResolvedValue(economics);
    mockQueue = makeMockQueue();
    return new CompoundScheduler(mockQueue, [VAULT], { economicsProvider: provider, minNetYield });
  }

  afterEach(() => jest.clearAllMocks());

  test('equal threshold: net yield exactly at the policy threshold is scheduled', async () => {
    const scheduler = makeScheduler({ expectedReward: '1000', estimatedFees: '400' });
    const result = await scheduler.scheduleVault(VAULT);

    expect(result).toEqual({ scheduled: true });
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
  });

  test('fluctuating fees: rising fees push the vault below the threshold', async () => {
    const economics: CompoundEconomics = { expectedReward: '1000', estimatedFees: '300' };
    const provider = jest.fn().mockResolvedValue(economics);
    mockQueue = makeMockQueue();
    const scheduler = new CompoundScheduler(mockQueue, [VAULT], {
      economicsProvider: provider,
      minNetYield: '600',
    });

    // Window 1: fees are low → net 700 ≥ 600 → scheduled.
    expect(await scheduler.scheduleVault(VAULT)).toEqual({ scheduled: true });
    expect(mockQueue.add).toHaveBeenCalledTimes(1);

    // Window 2: fees spike → net 550 < 600 → skipped, no new repeatable job.
    economics.estimatedFees = '450';
    expect(await scheduler.scheduleVault(VAULT)).toEqual({
      scheduled: false,
      reason: 'NET_YIELD_BELOW_THRESHOLD',
    });
    expect(mockQueue.add).toHaveBeenCalledTimes(1);

    // Window 3: fees subside → net 650 ≥ 600 → scheduled again.
    economics.estimatedFees = '350';
    expect(await scheduler.scheduleVault(VAULT)).toEqual({ scheduled: true });
    expect(mockQueue.add).toHaveBeenCalledTimes(2);
  });

  test('provider failure keeps scheduling (gate degrades open)', async () => {
    const provider = jest.fn().mockRejectedValue(new Error('oracle down'));
    mockQueue = makeMockQueue();
    const scheduler = new CompoundScheduler(mockQueue, [VAULT], {
      economicsProvider: provider,
      minNetYield: '600',
    });

    const result = await scheduler.scheduleVault(VAULT);
    expect(result).toEqual({ scheduled: true });
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
  });

  test('no economics provider preserves existing always-schedule behaviour', async () => {
    mockQueue = makeMockQueue();
    const scheduler = new CompoundScheduler(mockQueue, [VAULT]);

    const result = await scheduler.scheduleVault(VAULT);
    expect(result).toEqual({ scheduled: true });
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
  });

  test('default threshold "0" skips only loss-making compounds', async () => {
    mockQueue = makeMockQueue();
    const zeroLossProvider = jest
      .fn()
      .mockResolvedValue({ expectedReward: '100', estimatedFees: '100' });
    const lossProvider = jest
      .fn()
      .mockResolvedValue({ expectedReward: '100', estimatedFees: '101' });

    const breakEvenScheduler = new CompoundScheduler(mockQueue, [VAULT], {
      economicsProvider: zeroLossProvider,
    });
    expect(config.keeper.compoundMinNetYield).toBe('0');
    expect(await breakEvenScheduler.scheduleVault(VAULT)).toEqual({ scheduled: true });

    const lossScheduler = new CompoundScheduler(mockQueue, [VAULT], {
      economicsProvider: lossProvider,
    });
    expect(await lossScheduler.scheduleVault(VAULT)).toEqual({
      scheduled: false,
      reason: 'NET_YIELD_BELOW_THRESHOLD',
    });
  });

  test('shouldCompound() surfaces the decision without touching the queue', async () => {
    const scheduler = makeScheduler({ expectedReward: '1000', estimatedFees: '401' });
    const decision = await scheduler.shouldCompound(VAULT);

    expect(decision).toEqual({
      eligible: false,
      netYield: '599',
      minNetYield: '600',
      reason: 'NET_YIELD_BELOW_THRESHOLD',
    });
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  test('start() skips unprofitable vaults and schedules profitable ones', async () => {
    const economicsByVault: Record<string, CompoundEconomics> = {
      CVAULT_RICH: { expectedReward: '5000', estimatedFees: '500' },
      CVAULT_POOR: { expectedReward: '500', estimatedFees: '450' },
    };
    const provider: CompoundEconomicsProvider = jest.fn(
      async (vault: string) => economicsByVault[vault] ?? null,
    );
    mockQueue = makeMockQueue();
    const scheduler = new CompoundScheduler(mockQueue, ['CVAULT_RICH', 'CVAULT_POOR'], {
      economicsProvider: provider,
      minNetYield: '1000',
    });

    await scheduler.start();

    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add).toHaveBeenCalledWith(
      'compound:CVAULT_RICH',
      expect.objectContaining({ vaultContractId: 'CVAULT_RICH' }),
      expect.any(Object),
    );
  });
});
