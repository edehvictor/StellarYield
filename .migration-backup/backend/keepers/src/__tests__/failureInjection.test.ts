/**
 * Failure-injection tests for keeper external dependencies.
 *
 * Verifies that critical keeper paths degrade safely when Soroban RPC
 * is unavailable, returns malformed data, or times out.
 */

import { VaultMonitor } from '../monitors/VaultMonitor';
import { LiquidationWorker } from '../workers/LiquidationWorker';
import { KeeperSigner } from '../signer/KeeperSigner';
import type { Queue } from 'bullmq';
import type { LiquidationJobData } from '../queues/types';

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
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getContractData: jest.fn(),
    })),
    Durability: { Persistent: 'persistent' },
  },
  xdr: {
    ScValType: { scvMap: () => 'scvMap', scvSymbol: () => 'scvSymbol' },
    ScVal: { scvSymbol: jest.fn(), scvMap: jest.fn() },
    ScMapEntry: jest.fn(),
  },
  scValToNative: jest.fn(),
  Address: jest.fn().mockImplementation((addr: string) => ({
    toScVal: jest.fn().mockReturnValue({ type: 'address', value: addr }),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockQueue(): jest.Mocked<Queue<LiquidationJobData>> {
  return {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Queue<LiquidationJobData>>;
}

function getRpcServer() {
  const { rpc } = require('@stellar/stellar-sdk');
  return rpc.Server.mock.results[0]?.value as Record<string, jest.Mock>;
}

// ── VaultMonitor failure tests ─────────────────────────────────────────────────

describe('Failure injection: VaultMonitor — Soroban RPC outage', () => {
  let queue: jest.Mocked<Queue<LiquidationJobData>>;
  let monitor: VaultMonitor;

  beforeEach(() => {
    jest.clearAllMocks();
    queue = makeMockQueue();
    monitor = new VaultMonitor(queue);
  });

  it('scan() does not throw when Soroban RPC is unavailable', async () => {
    const rpcServer = getRpcServer();
    rpcServer.getContractData.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(monitor.scan()).resolves.not.toThrow();
  });

  it('scan() enqueues no jobs when Soroban RPC rejects all contract data calls', async () => {
    const rpcServer = getRpcServer();
    rpcServer.getContractData.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await monitor.scan();

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('scan() does not throw on connection timeout', async () => {
    const rpcServer = getRpcServer();
    rpcServer.getContractData.mockImplementation(
      () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 50)),
    );

    await expect(monitor.scan()).resolves.not.toThrow();
  });

  it('scan() enqueues no jobs when getContractData times out', async () => {
    const rpcServer = getRpcServer();
    rpcServer.getContractData.mockImplementation(
      () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 50)),
    );

    await monitor.scan();

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('parseEntry() returns null for malformed / null contract data entry', () => {
    // getCumulativeIndex default: 1e18 (BigInt)
    const result = (monitor as any).parseEntry(null, BigInt('1000000000000000000'));
    expect(result).toBeNull();
  });

  it('parseEntry() returns null for entry with missing map fields', () => {
    const malformedEntry = { val: { contractData: () => ({ val: () => null }) } };
    const result = (monitor as any).parseEntry(malformedEntry, BigInt('1000000000000000000'));
    expect(result).toBeNull();
  });
});

// ── LiquidationWorker failure tests ───────────────────────────────────────────

describe('Failure injection: LiquidationWorker — Soroban RPC timeout', () => {
  let mockSigner: jest.Mocked<KeeperSigner>;
  let worker: LiquidationWorker;

  const jobData: LiquidationJobData = {
    accountAddress: 'GFAILURE_TEST',
    currentCrBps: 8500,
    collateralValueUsd: '70000',
    debtAmount: '60000',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSigner = {
      publicKey: 'GKEEPER_TEST',
      invokeContract: jest.fn(),
    } as unknown as jest.Mocked<KeeperSigner>;
    worker = new LiquidationWorker(mockSigner);
  });

  it('process() throws when the Soroban RPC times out, allowing BullMQ to retry', async () => {
    mockSigner.invokeContract.mockRejectedValue(new Error('RPC request timed out'));

    const job = { id: 'failure-1', data: jobData } as any;

    await expect(worker.process(job)).rejects.toThrow('RPC request timed out');
  });

  it('process() throws on service unavailable (HTTP 503), preserving retry eligibility', async () => {
    mockSigner.invokeContract.mockRejectedValue(new Error('HTTP 503 Service Unavailable'));

    const job = { id: 'failure-2', data: jobData } as any;

    await expect(worker.process(job)).rejects.toThrow('503');
  });

  it('process() throws on malformed RPC response, preserving retry eligibility', async () => {
    mockSigner.invokeContract.mockRejectedValue(new SyntaxError('Unexpected token in JSON'));

    const job = { id: 'failure-3', data: jobData } as any;

    await expect(worker.process(job)).rejects.toThrow(SyntaxError);
  });
});
