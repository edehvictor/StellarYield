import { LiquidationWorker } from '../workers/LiquidationWorker';
import { KeeperSigner } from '../signer/KeeperSigner';
import { Job } from 'bullmq';
import { LiquidationJobData } from '../queues/types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../utils/redis', () => ({
  getRedis: jest.fn().mockReturnValue({ status: 'ready', on: jest.fn() }),
}));

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name, _processor, _opts) => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Address: jest.fn().mockImplementation((addr) => ({
    toScVal: jest.fn().mockReturnValue({ type: 'address', value: addr }),
  })),
}));

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('LiquidationWorker', () => {
  let mockSigner: jest.Mocked<KeeperSigner>;
  let worker: LiquidationWorker;

  const sampleJobData: LiquidationJobData = {
    accountAddress: 'GUNDERCOLLATERALIZED',
    currentCrBps: 9500,
    collateralValueUsd: '100000',
    debtAmount: '50000',
  };

  beforeEach(() => {
    mockSigner = {
      publicKey: 'GKEEPER123',
      invokeContract: jest.fn().mockResolvedValue('TX_HASH_ABC123'),
    } as unknown as jest.Mocked<KeeperSigner>;

    worker = new LiquidationWorker(mockSigner);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('process() calls invokeContract with correct method and args', async () => {
    const mockJob = {
      id: '1',
      data: sampleJobData,
    } as Job<LiquidationJobData>;

    const result = await worker.process(mockJob);

    expect(mockSigner.invokeContract).toHaveBeenCalledWith(
      expect.any(String), // contract ID from config
      'liquidate',
      expect.arrayContaining([expect.anything(), expect.anything()]),
    );
    expect(result).toEqual({ txHash: 'TX_HASH_ABC123' });
  });

  test('process() returns the transaction hash on success', async () => {
    mockSigner.invokeContract.mockResolvedValue('DEADBEEF_TX_HASH');

    const mockJob = { id: '2', data: sampleJobData } as Job<LiquidationJobData>;
    const result = await worker.process(mockJob);

    expect(result.txHash).toBe('DEADBEEF_TX_HASH');
  });

  test('process() propagates errors from invokeContract (triggers BullMQ retry)', async () => {
    mockSigner.invokeContract.mockRejectedValue(new Error('Simulation failed'));

    const mockJob = { id: '3', data: sampleJobData } as Job<LiquidationJobData>;

    await expect(worker.process(mockJob)).rejects.toThrow('Simulation failed');
  });

  test('close() closes the underlying BullMQ worker', async () => {
    await worker.close();
    const { Worker } = require('bullmq');
    const workerInstance = Worker.mock.results[0].value;
    expect(workerInstance.close).toHaveBeenCalled();
  });

  // ── Event callbacks ──────────────────────────────────────────────────────────

  test('Worker "completed" event logs the job ID and account address', () => {
    const { Worker } = require('bullmq');
    const workerInstance = Worker.mock.results[0].value;
    const onCalls = (workerInstance.on as jest.Mock).mock.calls;

    const completedHandler = onCalls.find(([event]: [string]) => event === 'completed')?.[1];
    expect(completedHandler).toBeDefined();
    // Should not throw when invoked with a completed job
    expect(() => completedHandler({ id: 'j1', data: sampleJobData })).not.toThrow();
  });

  test('Worker "failed" event logs the job ID and error', () => {
    const { Worker } = require('bullmq');
    const workerInstance = Worker.mock.results[0].value;
    const onCalls = (workerInstance.on as jest.Mock).mock.calls;

    const failedHandler = onCalls.find(([event]: [string]) => event === 'failed')?.[1];
    expect(failedHandler).toBeDefined();
    // Should not throw even when called with null job (e.g. stalled jobs)
    expect(() => failedHandler(null, new Error('timeout'))).not.toThrow();
    expect(() => failedHandler({ id: 'j2', data: sampleJobData }, new Error('rpc error'))).not.toThrow();
  });
});
