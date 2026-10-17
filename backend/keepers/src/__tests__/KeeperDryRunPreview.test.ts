import { KeeperSigner } from '../signer/KeeperSigner';
import { LiquidationWorker } from '../workers/LiquidationWorker';
import { CompoundWorker } from '../workers/CompoundWorker';
import { Job } from 'bullmq';
import { LiquidationJobData, CompoundJobData } from '../queues/types';

jest.mock('../utils/redis', () => ({
  getRedis: jest.fn().mockReturnValue({ status: 'ready', on: jest.fn(), get: jest.fn(), set: jest.fn() }),
}));

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Queue: jest.fn().mockImplementation((name: string) => ({
    name,
    add: jest.fn().mockResolvedValue({ id: 'mock-job' }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...(actual.rpc ?? {}),
      Server: jest.fn().mockImplementation(() => ({
        getAccount: jest.fn(),
        simulateTransaction: jest.fn(),
        sendTransaction: jest.fn(),
        getTransaction: jest.fn(),
      })),
      assembleTransaction: jest.fn(),
      Api: {
        isSimulationError: jest.fn().mockReturnValue(false),
        isSimulationSuccess: jest.fn().mockReturnValue(true),
        GetTransactionStatus: {
          SUCCESS: 'SUCCESS',
          FAILED: 'FAILED',
        },
      },
    },
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: jest.fn().mockReturnValue('GKEEPER_TEST_PUBLIC'),
        sign: jest.fn(),
      }),
    },
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({ sign: jest.fn() }),
    })),
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnValue({ type: 'op' }),
    })),
    Address: jest.fn().mockImplementation((addr: string) => ({
      toScVal: jest.fn().mockReturnValue({ type: 'address', value: addr }),
    })),
    nativeToScVal: jest.fn().mockReturnValue({ type: 'i128', value: 0n }),
  };
});

describe('Keeper Dry-Run Mode & Signed Payload Preview (#1542)', () => {
  const FAKE_SECRET = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  let mockServer: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { rpc } = require('@stellar/stellar-sdk');

    const mockSignedTx = {
      sign: jest.fn(),
      toXDR: jest.fn().mockReturnValue('AAAA_SIGNED_TX_XDR_BASE64'),
      hash: jest.fn().mockReturnValue(Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex')),
    };

    rpc.assembleTransaction.mockReturnValue({
      build: jest.fn().mockReturnValue(mockSignedTx),
    });
    rpc.Api.isSimulationError.mockReturnValue(false);
    rpc.Api.isSimulationSuccess.mockReturnValue(true);

    mockServer = {
      getAccount: jest.fn().mockResolvedValue({
        sequence: '100',
        accountId: () => 'GKEEPER_TEST_PUBLIC',
      }),
      simulateTransaction: jest.fn().mockResolvedValue({
        minResourceFee: '12345',
        results: [{ auth: [] }],
      }),
      sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'TX_BROADCAST_HASH' }),
      getTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
    };

    rpc.Server.mockImplementation(() => mockServer);
  });

  describe('KeeperSigner.dryRunInvokeContract', () => {
    it('builds, simulates, and signs payload WITHOUT broadcasting (zero sendTransaction calls)', async () => {
      const signer = new KeeperSigner(FAKE_SECRET);

      const preview = await signer.dryRunInvokeContract(
        'CSTABLECOIN_MANAGER',
        'liquidate',
        [],
        { requiredSequence: 100, fencingToken: 1 },
      );

      expect(mockServer.getAccount).toHaveBeenCalled();
      expect(mockServer.simulateTransaction).toHaveBeenCalled();
      // Crucial requirement: NEVER broadcast to the network
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
      expect(mockServer.getTransaction).not.toHaveBeenCalled();

      // Verify payload preview contents
      expect(preview).toBeDefined();
      expect(preview.contractId).toBe('CSTABLECOIN_MANAGER');
      expect(preview.method).toBe('liquidate');
      expect(preview.signedTxXdr).toBe('AAAA_SIGNED_TX_XDR_BASE64');
      expect(preview.txHash).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
      expect(preview.minResourceFee).toBe('12345');
      expect(preview.signerPublicKey).toBe('GKEEPER_TEST_PUBLIC');
    });

    it('rejects unauthorized operations before simulation or signing', async () => {
      const signer = new KeeperSigner(FAKE_SECRET);

      await expect(
        signer.dryRunInvokeContract('CSTABLECOIN_MANAGER', 'unauthorized_dangerous_method', []),
      ).rejects.toThrow(/not authorized to perform operation/);

      expect(mockServer.simulateTransaction).not.toHaveBeenCalled();
    });

    it('enforces sequence match in dry run mode', async () => {
      const signer = new KeeperSigner(FAKE_SECRET);

      await expect(
        signer.dryRunInvokeContract('CSTABLECOIN_MANAGER', 'liquidate', [], { requiredSequence: 999 }),
      ).rejects.toThrow('SEQUENCE_MISMATCH');

      expect(mockServer.simulateTransaction).not.toHaveBeenCalled();
    });
  });

  describe('LiquidationWorker.dryRun', () => {
    it('produces dry-run signed payload preview without mutating job state or broadcasting', async () => {
      const signer = new KeeperSigner(FAKE_SECRET);
      const worker = new LiquidationWorker(signer);

      const jobData: LiquidationJobData = {
        accountAddress: 'GACCOUNT_TARGET_123',
        currentCrBps: 10200,
        collateralValueUsd: '10000000',
        debtAmount: '5000000',
        fencingToken: 0,
        requiredSequence: 100,
      };

      const mockJob = {
        id: 'job-dry-1',
        data: jobData,
        attemptsMade: 0,
      } as Job<LiquidationJobData>;

      const preview = await worker.dryRun(mockJob);

      expect(preview).toBeDefined();
      expect(preview.method).toBe('liquidate');
      expect(preview.signedTxXdr).toBe('AAAA_SIGNED_TX_XDR_BASE64');
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe('CompoundWorker.dryRun', () => {
    it('produces dry-run preview for harvest operation without mutating job state or broadcasting', async () => {
      const signer = new KeeperSigner(FAKE_SECRET);
      const worker = new CompoundWorker(signer);

      const jobData: CompoundJobData = {
        vaultContractId: 'CVAULT_HARVEST_123',
        minHarvestAmount: '1000000',
        fencingToken: 0,
        requiredSequence: 100,
      };

      const mockJob = {
        id: 'job-compound-dry-1',
        data: jobData,
        attemptsMade: 0,
      } as Job<CompoundJobData>;

      const preview = await worker.dryRun(mockJob);

      expect(preview).toBeDefined();
      expect(preview.contractId).toBe('CVAULT_HARVEST_123');
      expect(preview.method).toBe('harvest');
      expect(preview.signedTxXdr).toBe('AAAA_SIGNED_TX_XDR_BASE64');
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
    });
  });
});
