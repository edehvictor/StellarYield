import { CompoundWorker } from '../workers/CompoundWorker';
import { KeeperSigner } from '../signer/KeeperSigner';
import { Job } from 'bullmq';
import { CompoundJobData } from '../queues/types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../utils/redis', () => ({
  getRedis: jest.fn().mockReturnValue({ status: 'ready', on: jest.fn() }),
}));

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation((_name: string, _processor: unknown, _opts: unknown) => ({
    on: jest.fn(),
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

describe('CompoundWorker', () => {
  let mockSigner: jest.Mocked<KeeperSigner>;
  let worker: CompoundWorker;

  const sampleJobData: CompoundJobData = {
    vaultContractId: 'CVAULT_AAAA',
    minHarvestAmount: '1000000',
  };

  beforeEach(() => {
    mockSigner = {
      publicKey: 'GKEEPER123',
      invokeContract: jest.fn().mockResolvedValue('COMPOUND_TX_HASH'),
    } as unknown as jest.Mocked<KeeperSigner>;

    worker = new CompoundWorker(mockSigner);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── process() ────────────────────────────────────────────────────────────────

  test('process() calls invokeContract with "harvest" method and correct contract', async () => {
    const mockJob = {
      id: 'job-cmp-1',
      data: sampleJobData,
    } as Job<CompoundJobData>;

    const result = await worker.process(mockJob);

    expect(mockSigner.invokeContract).toHaveBeenCalledWith(
      sampleJobData.vaultContractId,
      'harvest',
      expect.arrayContaining([expect.anything(), expect.anything()]),
    );
    expect(result).toEqual({ txHash: 'COMPOUND_TX_HASH' });
  });

  test('process() passes keeper public key as first arg', async () => {
    const mockJob = { id: 'job-cmp-2', data: sampleJobData } as Job<CompoundJobData>;
    await worker.process(mockJob);

    const { Address } = require('@stellar/stellar-sdk');
    expect(Address).toHaveBeenCalledWith('GKEEPER123');
  });

  test('process() converts minHarvestAmount to i128 ScVal', async () => {
    const mockJob = {
      id: 'job-cmp-3',
      data: { vaultContractId: 'CVAULT_BBBB', minHarvestAmount: '5000000' },
    } as Job<CompoundJobData>;

    await worker.process(mockJob);

    const { nativeToScVal } = require('@stellar/stellar-sdk');
    expect(nativeToScVal).toHaveBeenCalledWith(BigInt('5000000'), { type: 'i128' });
  });

  test('process() returns the transaction hash on success', async () => {
    mockSigner.invokeContract.mockResolvedValue('SPECIFIC_HASH_XYZ');

    const result = await worker.process({
      id: 'job-cmp-4',
      data: sampleJobData,
    } as Job<CompoundJobData>);

    expect(result.txHash).toBe('SPECIFIC_HASH_XYZ');
  });

  test('process() propagates errors from invokeContract (triggers BullMQ retry)', async () => {
    mockSigner.invokeContract.mockRejectedValue(new Error('Contract reverted: harvest error'));

    await expect(
      worker.process({ id: 'job-cmp-5', data: sampleJobData } as Job<CompoundJobData>),
    ).rejects.toThrow('Contract reverted: harvest error');
  });

  test('process() handles zero minHarvestAmount correctly', async () => {
    const mockJob = {
      id: 'job-cmp-6',
      data: { vaultContractId: 'CVAULT_ZERO', minHarvestAmount: '0' },
    } as Job<CompoundJobData>;

    await worker.process(mockJob);

    const { nativeToScVal } = require('@stellar/stellar-sdk');
    expect(nativeToScVal).toHaveBeenCalledWith(0n, { type: 'i128' });
  });

  // ── close() ───────────────────────────────────────────────────────────────────

  test('close() closes the underlying BullMQ worker', async () => {
    await worker.close();
    const { Worker } = require('bullmq');
    const workerInstance = Worker.mock.results[0].value;
    expect(workerInstance.close).toHaveBeenCalled();
  });

  // ── Event callbacks ──────────────────────────────────────────────────────────

  test('Worker "completed" event logs vault and job ID without throwing', () => {
    const { Worker } = require('bullmq');
    const workerInstance = Worker.mock.results[0].value;
    const onCalls = (workerInstance.on as jest.Mock).mock.calls;

    const completedHandler = onCalls.find(([event]: [string]) => event === 'completed')?.[1];
    expect(completedHandler).toBeDefined();
    expect(() => completedHandler({ id: 'cj1', data: sampleJobData })).not.toThrow();
  });

  test('Worker "failed" event logs job ID and error without throwing', () => {
    const { Worker } = require('bullmq');
    const workerInstance = Worker.mock.results[0].value;
    const onCalls = (workerInstance.on as jest.Mock).mock.calls;

    const failedHandler = onCalls.find(([event]: [string]) => event === 'failed')?.[1];
    expect(failedHandler).toBeDefined();
    expect(() => failedHandler(null, new Error('harvest failed'))).not.toThrow();
    expect(() => failedHandler({ id: 'cj2', data: sampleJobData }, new Error('slippage'))).not.toThrow();
  });
});
