import { LiquidationWorker } from '../workers/LiquidationWorker';
import { KeeperSigner } from '../signer/KeeperSigner';
import { Job } from 'bullmq';
import { LiquidationJobData } from '../queues/types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../utils/redis', () => ({
  getRedis: jest.fn().mockReturnValue({ status: 'ready', on: jest.fn() }),
}));

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, _processor: unknown, _opts: unknown) => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Queue: jest.fn().mockImplementation((name: string) => ({
    name,
    add: jest.fn().mockResolvedValue({ id: 'poison-job' }),
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

describe('LiquidationWorker', () => {
  let mockSigner: any;
  let worker: LiquidationWorker;

  const sampleJobData: LiquidationJobData = {
    accountAddress: 'GACCOUNT_123',
    currentCrBps: 10500,
    collateralValueUsd: '1000000000',
    debtAmount: '500000000',
    fencingToken: 0,
    requiredSequence: 42,
  };

  beforeEach(() => {
    mockSigner = {
      publicKey: 'GKEEPER123',
      invokeContract: jest.fn().mockResolvedValue('LIQUIDATION_TX_HASH'),
      server: {
        getAccount: jest.fn().mockResolvedValue({ sequence: '42' }),
      },
    };

    worker = new LiquidationWorker(mockSigner);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── process() ────────────────────────────────────────────────────────────────

  test('process() calls invokeContract with "liquidate" method and correct contract', async () => {
    const mockJob = {
      id: 'job-liq-1',
      data: sampleJobData,
      attemptsMade: 0,
    } as Job<LiquidationJobData>;

    const result = await worker.process(mockJob);

    expect(mockSigner.invokeContract).toHaveBeenCalledWith(
      expect.any(String),
      'liquidate',
      expect.arrayContaining([expect.anything(), expect.anything()]),
      expect.objectContaining({ workerName: 'LiquidationWorker', jobId: '1' }),
    );
    expect(result).toEqual({ txHash: 'LIQUIDATION_TX_HASH' });
  });

  test('process() passes keeper public key as first arg', async () => {
    const mockJob = { id: 'job-liq-2', data: sampleJobData, attemptsMade: 0 } as Job<LiquidationJobData>;
    await worker.process(mockJob);

    const { Address } = require('@stellar/stellar-sdk');
    expect(Address).toHaveBeenCalledWith('GKEEPER123');
  });

  test('process() verifies Stellar sequence before submission', async () => {
    const mockJob = {
      id: 'job-liq-4',
      data: { ...sampleJobData, requiredSequence: 999 },
      attemptsMade: 0,
    } as Job<LiquidationJobData>;

    mockSigner.server.getAccount = jest.fn().mockResolvedValue({ sequence: '42' });

    await expect(worker.process(mockJob)).rejects.toThrow('SEQUENCE_MISMATCH');
  });

  test('process() propagates errors from invokeContract (triggers retry/quarantine)', async () => {
    mockSigner.invokeContract.mockRejectedValue(new Error('Contract reverted: liquidation error'));

    await expect(
      worker.process({ id: 'job-liq-5', data: sampleJobData, attemptsMade: 0 } as Job<LiquidationJobData>),
    ).rejects.toThrow('Contract reverted: liquidation error');
  });

  test('close() closes the underlying BullMQ worker', async () => {
    await worker.close();
    const { Worker } = require('bullmq');
    const workerInstance = Worker.mock.results[0].value;
    expect(workerInstance.close).toHaveBeenCalled();
  });

  test('Worker "failed" event logs job ID and error without throwing', () => {
    const { Worker } = require('bullmq');
    const workerInstance = Worker.mock.results[0].value;
    const onCalls = (workerInstance.on as any).mock.calls;

    const failedHandler = onCalls.find(([event]: [string]) => event === 'failed')?.[1];
    expect(failedHandler).toBeDefined();
    expect(() => failedHandler(null, new Error('liquidation failed'))).not.toThrow();
    expect(() => failedHandler({ id: 'lj2', data: sampleJobData }, new Error('undercollateralized'))).not.toThrow();
  });
});