import { CompoundWorker } from '../workers/CompoundWorker';
import {
  compoundPeriodKey,
  COMPOUND_PERIOD_MS,
  getCompoundBroadcastRecord,
} from '../queues';
import { Job } from 'bullmq';
import { CompoundJobData } from '../queues/types';

// ── In-memory Redis shared across simulated "restarts" ─────────────────────────

const mockRedisStore = new Map<string, string>();

jest.mock('../utils/redis', () => ({
  getRedis: jest.fn().mockReturnValue({
    status: 'ready',
    on: jest.fn(),
    get: jest.fn(async (key: string) => mockRedisStore.get(key) ?? null),
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      mockRedisStore.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      mockRedisStore.delete(key);
      return 1;
    }),
  }),
}));

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, _processor: unknown, _opts: unknown) => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: 'q-job' }),
    removeRepeatable: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Address: jest.fn().mockImplementation((addr: string) => ({
    toScVal: jest.fn().mockReturnValue({ type: 'address', value: addr }),
  })),
  nativeToScVal: jest.fn().mockReturnValue({ type: 'i128', value: 0n }),
}));

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CompoundWorker idempotency across worker restarts (#1533)', () => {
  const VAULT = 'CVAULT_IDEM';
  /** Fixed clock instant so the derived period key is deterministic. */
  const FIXED_NOW_MS = 1_760_000_000_000;

  let mockSigner: any;

  function makeJob(periodKey: string, id = 'job-idem-1'): Job<CompoundJobData> {
    return {
      id,
      attemptsMade: 0,
      data: {
        vaultContractId: VAULT,
        minHarvestAmount: '1000',
        fencingToken: 0,
        requiredSequence: 1,
        periodKey,
      },
    } as Job<CompoundJobData>;
  }

  beforeEach(() => {
    mockRedisStore.clear();
    mockSigner = {
      publicKey: 'GKEEPER123',
      invokeContract: jest.fn().mockResolvedValue('TX_HASH_FIRST'),
      server: {
        getAccount: jest.fn().mockResolvedValue({ sequence: '1' }),
      },
    };
  });

  afterEach(() => jest.clearAllMocks());

  // ── compoundPeriodKey determinism ─────────────────────────────────────────────

  test('compoundPeriodKey() is stable for every instant in the same 4h window', () => {
    const windowStart = Math.floor(FIXED_NOW_MS / COMPOUND_PERIOD_MS) * COMPOUND_PERIOD_MS;
    expect(compoundPeriodKey(VAULT, windowStart)).toBe(compoundPeriodKey(VAULT, windowStart + 1));
    expect(compoundPeriodKey(VAULT, windowStart + COMPOUND_PERIOD_MS - 1)).toBe(
      compoundPeriodKey(VAULT, windowStart),
    );
  });

  test('compoundPeriodKey() differs across schedule windows', () => {
    const windowStart = Math.floor(FIXED_NOW_MS / COMPOUND_PERIOD_MS) * COMPOUND_PERIOD_MS;
    expect(compoundPeriodKey(VAULT, windowStart + COMPOUND_PERIOD_MS)).not.toBe(
      compoundPeriodKey(VAULT, windowStart),
    );
  });

  test('compoundPeriodKey() differs per vault for the same window', () => {
    expect(compoundPeriodKey('CVAULT_A', FIXED_NOW_MS)).not.toBe(
      compoundPeriodKey('CVAULT_B', FIXED_NOW_MS),
    );
  });

  // ── crash after broadcast, then restart ──────────────────────────────────────

  test('crash after broadcast + restart: retry does not double-compound', async () => {
    const periodKey = compoundPeriodKey(VAULT, FIXED_NOW_MS);

    // Attempt 1: broadcast succeeds and the durable record is written.
    const worker1 = new CompoundWorker(mockSigner);
    const first = await worker1.process(makeJob(periodKey, 'job-crash-1'));

    expect(mockSigner.invokeContract).toHaveBeenCalledTimes(1);
    expect(first.txHash).toBe('TX_HASH_FIRST');

    // The durable idempotency record is keyed by the stable vault + period key.
    const record = await getCompoundBroadcastRecord(periodKey);
    expect(record).toMatchObject({
      vaultContractId: VAULT,
      periodKey,
      txHash: 'TX_HASH_FIRST',
    });

    // Simulate a worker crash followed by a restart: a fresh worker picks up
    // the same period's job (new BullMQ delivery, higher attempt count) and
    // the transaction would be a different hash if it were re-broadcast.
    mockSigner.invokeContract.mockResolvedValue('TX_HASH_DOUBLE');
    const worker2 = new CompoundWorker(mockSigner);
    const second = await worker2.process(makeJob(periodKey, 'job-crash-1-r2'));

    expect(mockSigner.invokeContract).toHaveBeenCalledTimes(1); // no re-broadcast
    expect(second.txHash).toBe('TX_HASH_FIRST'); // original hash returned
  });

  test('restart after broadcast tolerates an advanced Stellar sequence', async () => {
    const periodKey = compoundPeriodKey(VAULT, FIXED_NOW_MS);

    const worker1 = new CompoundWorker(mockSigner);
    await worker1.process(makeJob(periodKey, 'job-seq-1'));

    // After the first broadcast the account sequence advanced; a re-run would
    // previously fail with SEQUENCE_MISMATCH. The idempotency gate must return
    // the recorded hash before any fencing/sequence validation runs.
    mockSigner.server.getAccount.mockResolvedValue({ sequence: '2' });
    const worker2 = new CompoundWorker(mockSigner);
    const second = await worker2.process(makeJob(periodKey, 'job-seq-1-r2'));

    expect(second.txHash).toBe('TX_HASH_FIRST');
    expect(mockSigner.server.getAccount).toHaveBeenCalledTimes(1); // only attempt 1
  });

  test('a fresh period broadcasts normally (no false dedup)', async () => {
    const periodKey1 = compoundPeriodKey(VAULT, FIXED_NOW_MS);
    const periodKey2 = compoundPeriodKey(VAULT, FIXED_NOW_MS + COMPOUND_PERIOD_MS);

    const worker1 = new CompoundWorker(mockSigner);
    await worker1.process(makeJob(periodKey1, 'job-p1'));

    mockSigner.invokeContract.mockResolvedValue('TX_HASH_PERIOD_2');
    const worker2 = new CompoundWorker(mockSigner);
    const second = await worker2.process(makeJob(periodKey2, 'job-p2'));

    expect(mockSigner.invokeContract).toHaveBeenCalledTimes(2);
    expect(second.txHash).toBe('TX_HASH_PERIOD_2');
  });

  test('missing periodKey in job data is derived from the current clock', async () => {
    const job: Job<CompoundJobData> = {
      id: 'job-derived',
      attemptsMade: 0,
      data: {
        vaultContractId: VAULT,
        minHarvestAmount: '1000',
        fencingToken: 0,
        requiredSequence: 1,
      },
    } as Job<CompoundJobData>;

    const worker = new CompoundWorker(mockSigner);
    await worker.process(job);

    const expectedKey = compoundPeriodKey(VAULT, Date.now());
    // Allow 1ms of slack across the await boundary at a window edge.
    const fallbackKey = compoundPeriodKey(VAULT, Date.now() + 1);
    const record =
      (await getCompoundBroadcastRecord(expectedKey)) ??
      (await getCompoundBroadcastRecord(fallbackKey));
    expect(record?.txHash).toBe('TX_HASH_FIRST');
  });

  test('duplicate detection survives across separate process() invocations', async () => {
    const periodKey = compoundPeriodKey(VAULT, FIXED_NOW_MS);

    const worker = new CompoundWorker(mockSigner);
    const first = await worker.process(makeJob(periodKey, 'job-dup-1'));
    const second = await worker.process(makeJob(periodKey, 'job-dup-2'));

    expect(mockSigner.invokeContract).toHaveBeenCalledTimes(1);
    expect(first.txHash).toBe(second.txHash);
  });
});
