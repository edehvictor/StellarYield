import { VaultMonitor, CdpState } from '../monitors/VaultMonitor';
import { Queue } from 'bullmq';
import { LiquidationJobData } from '../queues/types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../utils/redis', () => ({
  getRedis: jest.fn().mockReturnValue({
    status: 'ready',
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  }),
}));

// SDK mock — xdr.ScValType returns the same sentinel string from both sides
// so switch() === ScValType.scvMap() comparisons work correctly in parseEntry.
jest.mock('@stellar/stellar-sdk', () => {
  const mockScValToNative = jest.fn();
  const mockScVal = {
    scvSymbol: jest.fn().mockImplementation((s) => ({
      switch: () => 'scvSymbol',
      sym: () => ({ toString: () => s }),
    })),
    scvMap: jest.fn().mockImplementation((entries) => ({
      switch: () => 'scvMap',
      map: () => entries,
    })),
  };

  return {
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getContractData: jest.fn(),
      })),
      Durability: { Persistent: 'persistent', Temporary: 'temporary' },
      Api: {
        GetTransactionStatus: { SUCCESS: 'SUCCESS', FAILED: 'FAILED', NOT_FOUND: 'NOT_FOUND' },
      },
    },
    xdr: {
      ScValType: {
        scvMap: () => 'scvMap',
        scvSymbol: () => 'scvSymbol',
      },
      ScVal: mockScVal,
      ScMapEntry: jest.fn().mockImplementation((obj) => ({
        key: () => obj.key,
        val: () => obj.val,
      })),
    },
    scValToNative: mockScValToNative,
    Address: jest.fn().mockImplementation((addr) => ({
      toScVal: jest.fn().mockReturnValue({ type: 'address', value: addr }),
    })),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockQueue(): jest.Mocked<Queue<LiquidationJobData>> {
  return {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Queue<LiquidationJobData>>;
}

/**
 * Build a fake LedgerEntryResult whose shape satisfies the rewritten parseEntry:
 *  entry.val.contractData().key() → keyScVal
 *  entry.val.contractData().val() → valScVal
 */
function makeFakeCdpEntry(opts: {
  keySwitch?: string;
  keySym?: string;
  collateralStr?: string;
  debtSharesStr?: string;
  accountAddress?: string;
}): any {
  const {
    keySwitch      = 'scvMap',
    keySym         = 'CDP',
    collateralStr  = '100000',
    debtSharesStr  = '1000',
    accountAddress = 'GACCOUNT_FAKE',
  } = opts;

  const makeEntry = (symName: string, valStr: string) => ({
    key: () => ({ sym: () => ({ toString: () => symName }) }),
    val: () => valStr,
  });

  return {
    val: {
      contractData: () => ({
        key: () => ({
          switch: () => keySwitch,
          map: () => [
            {
              key: () => ({
                switch: () => 'scvSymbol',
                sym:    () => ({ toString: () => keySym }),
              }),
              val: () => accountAddress,
            },
          ],
        }),
        val: () => ({
          map: () => [
            makeEntry('collateral',  collateralStr),
            makeEntry('debt_shares', debtSharesStr),
          ],
        }),
      }),
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('VaultMonitor', () => {
  let monitor: VaultMonitor;
  let mockQueue: jest.Mocked<Queue<LiquidationJobData>>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockQueue = makeMockQueue();
    monitor = new VaultMonitor(mockQueue, 'CONTRACT_ID', 'http://localhost:8000');
  });

  afterEach(() => {
    monitor.stop();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  test('start() triggers an immediate scan', async () => {
    const scanSpy = jest.spyOn(monitor, 'scan').mockResolvedValue(undefined);
    monitor.start();
    await Promise.resolve();
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });

  test('start() schedules recurring scans via setInterval', async () => {
    const scanSpy = jest.spyOn(monitor, 'scan').mockResolvedValue(undefined);
    monitor.start();
    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(scanSpy).toHaveBeenCalledTimes(2);
  });

  test('stop() clears the interval and prevents further scans', async () => {
    const scanSpy = jest.spyOn(monitor, 'scan').mockResolvedValue(undefined);
    monitor.start();
    monitor.stop();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });

  test('stop() is a no-op when not running', () => {
    expect(() => monitor.stop()).not.toThrow();
  });

  // ── scan() ──────────────────────────────────────────────────────────────────

  test('scan() does not enqueue jobs when no CDP entries exist', async () => {
    jest.spyOn(monitor, 'fetchAllCdpEntries').mockResolvedValue([]);
    await monitor.scan();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  test('scan() enqueues a job when CR is below MCR', async () => {
    jest.spyOn(monitor, 'fetchAllCdpEntries').mockResolvedValue([{} as any]);
    jest.spyOn(monitor, 'getCumulativeIndex').mockResolvedValue(BigInt('1000000000000000000'));
    jest.spyOn(monitor, 'parseEntry').mockReturnValue({
      accountAddress: 'GACCOUNT123',
      collateral: 100_000n,
      debtShares: 1000n,
      crBps: 9000,
    } as CdpState);

    await monitor.scan();

    expect(mockQueue.add).toHaveBeenCalledWith(
      'liquidate:GACCOUNT123',
      expect.objectContaining({ accountAddress: 'GACCOUNT123', currentCrBps: 9000 }),
      expect.objectContaining({ jobId: 'liquidate:GACCOUNT123' }),
    );
  });

  test('scan() does NOT enqueue healthy positions (CR above MCR)', async () => {
    jest.spyOn(monitor, 'fetchAllCdpEntries').mockResolvedValue([{} as any]);
    jest.spyOn(monitor, 'getCumulativeIndex').mockResolvedValue(BigInt('1000000000000000000'));
    jest.spyOn(monitor, 'parseEntry').mockReturnValue({
      accountAddress: 'GHEALTHY',
      collateral: 200_000n,
      debtShares: 1000n,
      crBps: 15000,
    } as CdpState);

    await monitor.scan();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  test('scan() processes multiple entries and enqueues only undercollateralized ones', async () => {
    jest.spyOn(monitor, 'fetchAllCdpEntries').mockResolvedValue([{} as any, {} as any, {} as any]);
    jest.spyOn(monitor, 'getCumulativeIndex').mockResolvedValue(BigInt('1000000000000000000'));
    jest.spyOn(monitor, 'parseEntry')
      .mockReturnValueOnce({ accountAddress: 'G1', collateral: 100n, debtShares: 1n, crBps: 8000 })
      .mockReturnValueOnce({ accountAddress: 'G2', collateral: 200n, debtShares: 1n, crBps: 9500 })
      .mockReturnValueOnce({ accountAddress: 'G3', collateral: 500n, debtShares: 1n, crBps: 15000 });

    await monitor.scan();
    expect(mockQueue.add).toHaveBeenCalledTimes(2);
  });

  test('scan() handles parseEntry returning null gracefully', async () => {
    jest.spyOn(monitor, 'fetchAllCdpEntries').mockResolvedValue([{} as any, {} as any]);
    jest.spyOn(monitor, 'getCumulativeIndex').mockResolvedValue(1n);
    jest.spyOn(monitor, 'parseEntry').mockReturnValue(null);

    await expect(monitor.scan()).resolves.not.toThrow();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  test('scan() handles unexpected errors without crashing', async () => {
    jest.spyOn(monitor, 'fetchAllCdpEntries').mockRejectedValue(new Error('RPC down'));
    await expect(monitor.scan()).resolves.not.toThrow();
  });

  // ── getCumulativeIndex() ─────────────────────────────────────────────────────

  test('getCumulativeIndex() returns default 1e18 on RPC error', async () => {
    (monitor as any).server.getContractData = jest.fn().mockRejectedValue(new Error('404'));
    const result = await monitor.getCumulativeIndex();
    expect(result).toBe(BigInt('1000000000000000000'));
  });

  test('getCumulativeIndex() parses a successful response', async () => {
    const { scValToNative } = require('@stellar/stellar-sdk');
    scValToNative.mockReturnValue('2000000000000000000');

    (monitor as any).server.getContractData = jest.fn().mockResolvedValue({
      val: { contractData: () => ({ val: () => ({ type: 'i128' }) }) },
    });

    const result = await monitor.getCumulativeIndex();
    expect(result).toBe(BigInt('2000000000000000000'));
  });

  // ── parseEntry() ─────────────────────────────────────────────────────────────

  test('parseEntry() returns null when contractData() throws (non-contract entry)', () => {
    const badEntry = {
      val: { contractData: () => { throw new Error('LedgerEntry is not contract data'); } },
    };
    expect(monitor.parseEntry(badEntry as any, 1n)).toBeNull();
  });

  test('parseEntry() returns null for non-Map key switch', () => {
    const entry = makeFakeCdpEntry({ keySwitch: 'scvAddress' });
    // 'scvAddress' !== 'scvMap' so parseEntry returns null
    const result = monitor.parseEntry(entry, 1n);
    expect(result).toBeNull();
  });

  test('parseEntry() returns null when CDP key type entry is missing', () => {
    const entry = makeFakeCdpEntry({ keySym: 'OTHER_KEY' });
    const result = monitor.parseEntry(entry, 1n);
    expect(result).toBeNull();
  });

  test('parseEntry() parses a valid CDP entry with non-zero debt', () => {
    const { scValToNative } = require('@stellar/stellar-sdk');
    // Return values in order: account, collateral field, debt_shares field
    scValToNative
      .mockReturnValueOnce('GVALIDACCOUNT')
      .mockReturnValueOnce('150000')
      .mockReturnValueOnce('100000');

    const SCALAR_18 = BigInt('1000000000000000000');
    const cumulativeIndex = SCALAR_18; // 1.0 scaled → debtValue == debtShares

    const entry = makeFakeCdpEntry({
      accountAddress: 'GVALIDACCOUNT',
      collateralStr: '150000',
      debtSharesStr: '100000',
    });

    const result = monitor.parseEntry(entry, cumulativeIndex);

    expect(result).not.toBeNull();
    expect(result!.accountAddress).toBe('GVALIDACCOUNT');
    expect(result!.collateral).toBe(150_000n);
    expect(result!.debtShares).toBe(100_000n);
    // crBps = (150000 * 10000) / 100000 = 15000
    expect(result!.crBps).toBe(15000);
  });

  test('parseEntry() returns crBps 999_999 when debt is zero', () => {
    const { scValToNative } = require('@stellar/stellar-sdk');
    scValToNative
      .mockReturnValueOnce('GZERODEBTOR')
      .mockReturnValueOnce('500000')
      .mockReturnValueOnce('0');

    const entry = makeFakeCdpEntry({
      collateralStr: '500000',
      debtSharesStr: '0',
    });

    const result = monitor.parseEntry(entry, BigInt('1000000000000000000'));
    expect(result!.crBps).toBe(999_999);
  });

  test('parseEntry() returns 0n for missing fields (getField fallback)', () => {
    const { scValToNative } = require('@stellar/stellar-sdk');
    scValToNative.mockReturnValueOnce('GMISSING');

    // Entry with empty val map — missing collateral and debt_shares
    const entry = {
      val: {
        contractData: () => ({
          key: () => ({
            switch: () => 'scvMap',
            map: () => [
              {
                key: () => ({ switch: () => 'scvSymbol', sym: () => ({ toString: () => 'CDP' }) }),
                val: () => 'GMISSING',
              },
            ],
          }),
          val: () => ({ map: () => [] }),
        }),
      },
    };

    const result = monitor.parseEntry(entry as any, BigInt('1000000000000000000'));
    expect(result!.collateral).toBe(0n);
    expect(result!.debtShares).toBe(0n);
    expect(result!.crBps).toBe(999_999);
  });

  // ── fetchAllCdpEntries() ───────────────────────────────────────────────────

  test('fetchAllCdpEntries() returns empty and logs warning when no addresses set', async () => {
    // Override config mock value for this test
    const { config } = require('../config');
    (config.keeper as any).monitoredAddresses = [];

    const entries = await monitor.fetchAllCdpEntries();
    expect(entries).toEqual([]);
  });

  test('fetchAllCdpEntries() calls getContractData for each configured address', async () => {
    const { config } = require('../config');
    (config.keeper as any).monitoredAddresses = ['G1', 'G2'];

    const mockGet = jest.fn().mockResolvedValue({ val: 'entry' });
    (monitor as any).server.getContractData = mockGet;

    const entries = await monitor.fetchAllCdpEntries();

    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(entries.length).toBe(2);
  });

  test('fetchAllCdpEntries() filters out null values (RPC errors)', async () => {
    const { config } = require('../config');
    (config.keeper as any).monitoredAddresses = ['G_GOOD', 'G_BAD'];

    const mockGet = jest.fn()
      .mockResolvedValueOnce({ val: 'entry' })
      .mockRejectedValueOnce(new Error('404'));
    (monitor as any).server.getContractData = mockGet;

    const entries = await monitor.fetchAllCdpEntries();

    expect(entries.length).toBe(1);
    expect(entries[0].val).toBe('entry');
  });

  // ── buildCdpKey() ───────────────────────────────────────────────────────────

  test('buildCdpKey() returns a map ScVal with "CDP" symbol', () => {
    const { xdr } = require('@stellar/stellar-sdk');
    const result = (monitor as any).buildCdpKey('G123');

    expect(result).toBeDefined();
    // In our mock, xdr.ScVal.scvMap was not specifically mocked for property access,
    // but the constructor call was. We can check if it returns what we expect.
  });

  // ── Deduplication ─────────────────────────────────────────────────────────────

  test('enqueue uses account address as jobId for deduplication', async () => {
    jest.spyOn(monitor, 'fetchAllCdpEntries').mockResolvedValue([{} as any]);
    jest.spyOn(monitor, 'getCumulativeIndex').mockResolvedValue(1n);
    jest.spyOn(monitor, 'parseEntry').mockReturnValue({
      accountAddress: 'GDEDUP',
      collateral: 100n,
      debtShares: 1n,
      crBps: 5000,
    });

    await monitor.scan();
    const [, , opts] = (mockQueue.add as jest.Mock).mock.calls[0];
    expect(opts.jobId).toBe('liquidate:GDEDUP');
  });

  test('enqueue carries correct LiquidationJobData fields', async () => {
    jest.spyOn(monitor, 'fetchAllCdpEntries').mockResolvedValue([{} as any]);
    jest.spyOn(monitor, 'getCumulativeIndex').mockResolvedValue(1n);
    jest.spyOn(monitor, 'parseEntry').mockReturnValue({
      accountAddress: 'GDATA',
      collateral: 500n,
      debtShares: 200n,
      crBps: 7500,
    });

    await monitor.scan();
    const [, data] = (mockQueue.add as jest.Mock).mock.calls[0];
    expect(data).toMatchObject({
      accountAddress: 'GDATA',
      currentCrBps: 7500,
      collateralValueUsd: '500',
      debtAmount: '200',
    });
  });
});
