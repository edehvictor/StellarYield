import { CompoundScheduler } from '../monitors/CompoundScheduler';
import { Queue } from 'bullmq';
import { CompoundJobData } from '../queues/types';

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

describe('CompoundScheduler', () => {
  let mockQueue: jest.Mocked<Queue<CompoundJobData>>;
  let scheduler: CompoundScheduler;

  const VAULT_A = 'CVAULT_AAAA';
  const VAULT_B = 'CVAULT_BBBB';

  beforeEach(() => {
    mockQueue = makeMockQueue();
    scheduler = new CompoundScheduler(mockQueue, [VAULT_A, VAULT_B]);
  });

  afterEach(() => jest.clearAllMocks());

  test('start() schedules compound jobs for all registered vaults', async () => {
    await scheduler.start();
    expect(mockQueue.add).toHaveBeenCalledTimes(2);
    expect(mockQueue.add).toHaveBeenCalledWith(
      `compound:${VAULT_A}`,
      expect.objectContaining({ vaultContractId: VAULT_A }),
      expect.objectContaining({ jobId: `compound:${VAULT_A}`, repeat: expect.any(Object) }),
    );
    expect(mockQueue.add).toHaveBeenCalledWith(
      `compound:${VAULT_B}`,
      expect.objectContaining({ vaultContractId: VAULT_B }),
      expect.objectContaining({ jobId: `compound:${VAULT_B}` }),
    );
  });

  test('addVault() schedules a new vault and adds it to the list', async () => {
    await scheduler.addVault('CVAULT_NEW');
    expect(mockQueue.add).toHaveBeenCalledWith(
      'compound:CVAULT_NEW',
      expect.objectContaining({ vaultContractId: 'CVAULT_NEW' }),
      expect.any(Object),
    );
  });

  test('removeVault() removes the repeatable job and vault from the list', async () => {
    await scheduler.removeVault(VAULT_A);
    expect(mockQueue.removeRepeatable).toHaveBeenCalledWith(
      `compound:${VAULT_A}`,
      expect.any(Object),
    );
  });

  test('scheduleVault() sets a repeat cron pattern of every 4 hours', async () => {
    await scheduler.scheduleVault('CVAULT_CRON');
    expect(mockQueue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        repeat: { pattern: '0 */4 * * *' },
      }),
    );
  });

  test('start() with empty vault list schedules nothing', async () => {
    const emptyScheduler = new CompoundScheduler(mockQueue, []);
    await emptyScheduler.start();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });
});
