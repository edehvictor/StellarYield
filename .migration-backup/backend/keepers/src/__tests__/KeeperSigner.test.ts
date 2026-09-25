import fs from 'fs';
import os from 'os';
import path from 'path';
import { KeeperSigner, UnauthorizedOperationError } from '../signer/KeeperSigner';
import { LocalSignerProvider } from '../signer/SignerProvider';
import { createKeeperAuditLog } from '../audit/KeeperAuditLog';
import { logger } from '../utils/logger';

// ── Mocks ─────────────────────────────────────────────────────────────────────
// IMPORTANT: jest.mock() is hoisted to the top of the file by Babel/ts-jest,
// so const variables declared outside the factory are not yet initialised.
// All mock functions must be created *inside* the factory to avoid TDZ errors.

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
          NOT_FOUND: 'NOT_FOUND',
        },
      },
    },
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: jest.fn().mockReturnValue('GKEEPER_PUBLIC'),
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
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Return the mock server instance created by the last `new rpc.Server()` call. */
function getMockServer() {
  const { rpc } = require('@stellar/stellar-sdk');
  const [instance] = rpc.Server.mock.results;
  return instance?.value ?? rpc.Server.mock.results[0]?.value;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('KeeperSigner', () => {
  const FAKE_SECRET = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-initialise mock server methods after clearAllMocks
    const { rpc } = require('@stellar/stellar-sdk');

    const mockTxWithSign = { sign: jest.fn() };
    rpc.assembleTransaction.mockReturnValue({
      build: jest.fn().mockReturnValue(mockTxWithSign),
    });
    rpc.Api.isSimulationError.mockReturnValue(false);
    rpc.Api.isSimulationSuccess.mockReturnValue(true);

    // The Server constructor is called inside KeeperSigner, so we need to
    // set up what the *next* instance will return via the constructor mock.
    rpc.Server.mockImplementation(() => ({
      getAccount: jest.fn().mockResolvedValue({
        accountId: jest.fn().mockReturnValue('GKEEPER_PUBLIC'),
        sequenceNumber: jest.fn().mockReturnValue('0'),
        incrementSequenceNumber: jest.fn(),
      }),
      simulateTransaction: jest.fn().mockResolvedValue({ result: {}, cost: {} }),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: 'TXHASH123',
      }),
      getTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
    }));
  });

  test('publicKey returns the keypair public key', () => {
    const signer = new KeeperSigner(FAKE_SECRET);
    expect(signer.publicKey).toBe('GKEEPER_PUBLIC');
  });

  test('invokeContract returns tx hash on success', async () => {
    const signer = new KeeperSigner(FAKE_SECRET);
    const hash = await signer.invokeContract('CCONTRACT', 'liquidate', []);
    expect(hash).toBe('TXHASH123');
  });

  test('invokeContract throws on simulation error', async () => {
    const { rpc } = require('@stellar/stellar-sdk');
    rpc.Api.isSimulationError.mockReturnValue(true);

    rpc.Server.mockImplementation(() => ({
      getAccount: jest.fn().mockResolvedValue({
        accountId: jest.fn().mockReturnValue('GKEEPER_PUBLIC'),
        sequenceNumber: jest.fn().mockReturnValue('0'),
        incrementSequenceNumber: jest.fn(),
      }),
      simulateTransaction: jest.fn().mockResolvedValue({ error: 'Insufficient fee' }),
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    }));

    const signer = new KeeperSigner(FAKE_SECRET);
    await expect(
      signer.invokeContract('CCONTRACT', 'liquidate', []),
    ).rejects.toThrow('Simulation failed');
  });

  test('invokeContract throws when simulation is neither error nor success', async () => {
    const { rpc } = require('@stellar/stellar-sdk');
    rpc.Api.isSimulationError.mockReturnValue(false);
    rpc.Api.isSimulationSuccess.mockReturnValue(false); // restore response

    rpc.Server.mockImplementation(() => ({
      getAccount: jest.fn().mockResolvedValue({
        accountId: jest.fn().mockReturnValue('GKEEPER_PUBLIC'),
        sequenceNumber: jest.fn().mockReturnValue('0'),
        incrementSequenceNumber: jest.fn(),
      }),
      simulateTransaction: jest.fn().mockResolvedValue({ status: 'RESTORE' }),
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    }));

    const signer = new KeeperSigner(FAKE_SECRET);
    await expect(
      signer.invokeContract('CCONTRACT', 'liquidate', []),
    ).rejects.toThrow('Unexpected simulation response');
  });

  test('invokeContract throws when sendTransaction returns ERROR status', async () => {
    const { rpc } = require('@stellar/stellar-sdk');

    rpc.Server.mockImplementation(() => ({
      getAccount: jest.fn().mockResolvedValue({
        accountId: jest.fn().mockReturnValue('GKEEPER_PUBLIC'),
        sequenceNumber: jest.fn().mockReturnValue('0'),
        incrementSequenceNumber: jest.fn(),
      }),
      simulateTransaction: jest.fn().mockResolvedValue({ result: {}, cost: {} }),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'ERROR',
        errorResult: { toXDR: () => 'base64err' },
      }),
      getTransaction: jest.fn(),
    }));

    const signer = new KeeperSigner(FAKE_SECRET);
    await expect(
      signer.invokeContract('CCONTRACT', 'liquidate', []),
    ).rejects.toThrow('sendTransaction failed');
  });

  test('invokeContract throws if tx fails on-chain', async () => {
    const { rpc } = require('@stellar/stellar-sdk');

    rpc.Server.mockImplementation(() => ({
      getAccount: jest.fn().mockResolvedValue({
        accountId: jest.fn().mockReturnValue('GKEEPER_PUBLIC'),
        sequenceNumber: jest.fn().mockReturnValue('0'),
        incrementSequenceNumber: jest.fn(),
      }),
      simulateTransaction: jest.fn().mockResolvedValue({ result: {}, cost: {} }),
      sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'TXHASH999' }),
      getTransaction: jest.fn().mockResolvedValue({ status: 'FAILED' }),
    }));

    const signer = new KeeperSigner(FAKE_SECRET);
    await expect(
      signer.invokeContract('CCONTRACT', 'liquidate', []),
    ).rejects.toThrow('failed on-chain');
  });

  test('KeeperSigner throws on empty secret key', () => {
    expect(() => new KeeperSigner('')).toThrow('KEEPER_SECRET_KEY is not set');
  });

  test('invokeContract polls until NOT_FOUND resolves to SUCCESS', async () => {
    const { rpc } = require('@stellar/stellar-sdk');

    const getTransaction = jest
      .fn()
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValue({ status: 'SUCCESS' });

    rpc.Server.mockImplementation(() => ({
      getAccount: jest.fn().mockResolvedValue({
        accountId: jest.fn().mockReturnValue('GKEEPER_PUBLIC'),
        sequenceNumber: jest.fn().mockReturnValue('0'),
        incrementSequenceNumber: jest.fn(),
      }),
      simulateTransaction: jest.fn().mockResolvedValue({ result: {}, cost: {} }),
      sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'POLL_HASH' }),
      getTransaction,
    }));

    jest.useFakeTimers();
    const signer = new KeeperSigner(FAKE_SECRET);
    const promise = signer.invokeContract('CCONTRACT', 'harvest', []);

    // Flush the microtask chain up through simulate/sign/send before the
    // first poll `sleep()` registers its timer.
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
    }

    // Advance fake timers to flush the polling sleep calls
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    }

    const hash = await promise;
    expect(hash).toBe('POLL_HASH');
    jest.useRealTimers();
  });

  test('invokeContract throws after exceeding max poll attempts', async () => {
    const { rpc } = require('@stellar/stellar-sdk');

    rpc.Server.mockImplementation(() => ({
      getAccount: jest.fn().mockResolvedValue({
        accountId: jest.fn().mockReturnValue('GKEEPER_PUBLIC'),
        sequenceNumber: jest.fn().mockReturnValue('0'),
        incrementSequenceNumber: jest.fn(),
      }),
      simulateTransaction: jest.fn().mockResolvedValue({ result: {}, cost: {} }),
      sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'SLOW_HASH' }),
      getTransaction: jest.fn().mockResolvedValue({ status: 'NOT_FOUND' }),
    }));

    jest.useFakeTimers();
    const signer = new KeeperSigner(FAKE_SECRET);
    const promise = signer.invokeContract('CCONTRACT', 'harvest', []);

    // Drain all 15 poll cycles
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
    }

    await expect(promise).rejects.toThrow('did not confirm within timeout');
    jest.useRealTimers();
  });

  // ── #911: operation allowlist ─────────────────────────────────────────────

  test('invokeContract rejects an unauthorized operation before any account/transaction work', async () => {
    const signer = new KeeperSigner(FAKE_SECRET);

    await expect(
      signer.invokeContract('CCONTRACT', 'admin_withdraw', []),
    ).rejects.toBeInstanceOf(UnauthorizedOperationError);

    const server = getMockServer();
    expect(server.getAccount).not.toHaveBeenCalled();
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });

  test('a custom provider can authorize a narrower operation set than the default', async () => {
    const provider = new LocalSignerProvider(FAKE_SECRET, ['harvest']);
    const signer = new KeeperSigner(provider);

    await expect(
      signer.invokeContract('CCONTRACT', 'liquidate', []),
    ).rejects.toBeInstanceOf(UnauthorizedOperationError);

    // The allowed operation still succeeds.
    const hash = await signer.invokeContract('CCONTRACT', 'harvest', []);
    expect(hash).toBe('TXHASH123');
  });

  // ── #911: no key material in logs ─────────────────────────────────────────

  test('no substring of the secret key ever appears in a logger call across a full invoke cycle', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    const errorSpy = jest.spyOn(logger, 'error');

    const signer = new KeeperSigner(FAKE_SECRET);
    await signer.invokeContract('CCONTRACT', 'liquidate', []);

    const allCallArgs = [...infoSpy.mock.calls, ...errorSpy.mock.calls];
    const serialized = JSON.stringify(allCallArgs);

    expect(serialized).not.toContain(FAKE_SECRET);
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── #912: audit hook integration ──────────────────────────────────────────

  test('when an auditLog and auditContext are supplied, invokeContract records a decision and a success outcome', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-signer-audit-'));
    const auditLog = createKeeperAuditLog(dir);
    const signer = new KeeperSigner(FAKE_SECRET, { auditLog });

    const hash = await signer.invokeContract('CCONTRACT', 'liquidate', [], {
      workerName: 'LiquidationWorker',
      jobId: 'job-42',
      policyVersion: 'v1',
    });

    expect(hash).toBe('TXHASH123');

    const records = auditLog.exportStream('LiquidationWorker');
    expect(records).toHaveLength(2);
    expect(records[0].txOutcome).toBeNull();
    expect(records[0].simulationResult).toBeDefined();
    expect(records[1].txOutcome).toEqual({ status: 'success', hash: 'TXHASH123' });
    expect(auditLog.verifyStreamIntegrity('LiquidationWorker').isValid).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('invokeContract without an auditContext performs no audit writes even when auditLog is supplied', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-signer-audit-noop-'));
    const auditLog = createKeeperAuditLog(dir);
    const signer = new KeeperSigner(FAKE_SECRET, { auditLog });

    await signer.invokeContract('CCONTRACT', 'liquidate', []);

    expect(fs.existsSync(dir) && fs.readdirSync(dir).length).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
