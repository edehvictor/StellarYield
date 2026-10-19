import {
  calculateExpectedSeizedCollateral,
  evaluateLiquidationDryRun,
  MAX_PRICE_AGE_MS,
  LiquidationWorker,
} from '../workers/LiquidationWorker';
import { LiquidationJobData } from '../queues/types';
import { Job } from 'bullmq';

jest.mock('../utils/redis', () => ({
  getRedis: jest.fn().mockReturnValue({ status: 'ready', on: jest.fn() }),
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

jest.mock('@stellar/stellar-sdk', () => ({
  Address: jest.fn().mockImplementation((addr: string) => ({
    toScVal: jest.fn().mockReturnValue({ type: 'address', value: addr }),
  })),
  nativeToScVal: jest.fn().mockReturnValue({ type: 'i128', value: 0n }),
}));

describe('Liquidation Slippage Bounds (#1539)', () => {
  const baseJobData: LiquidationJobData = {
    accountAddress: 'GACCOUNT_SLIPPAGE_TEST',
    currentCrBps: 10500, // 105% undercollateralized (MCR is 110%)
    collateralValueUsd: '1000000000',
    debtAmount: '1000000000', // 1000 units of debt
    fencingToken: 0,
    requiredSequence: 10,
    oracleAvailable: true,
  };

  describe('calculateExpectedSeizedCollateral', () => {
    it('calculates expected seized collateral with default 10% penalty (11000 bps incentive)', () => {
      // 1000 debt * 11000 / (100 price * 10000) = 11 units of collateral
      const seized = calculateExpectedSeizedCollateral('1000', 100);
      expect(seized).toBe(11n);
    });

    it('calculates expected seized collateral accurately with custom incentive', () => {
      // 1000 debt * 10500 / (100 price * 10000) = 10.5 -> truncated to 10n
      const seized = calculateExpectedSeizedCollateral('1000', 100, 10500);
      expect(seized).toBe(10n);
    });

    it('throws error when oracle price is non-positive', () => {
      expect(() => calculateExpectedSeizedCollateral('1000', 0)).toThrow('Oracle price must be positive');
      expect(() => calculateExpectedSeizedCollateral('1000', -5)).toThrow('Oracle price must be positive');
    });
  });

  describe('Changing oracle values & slippage rejection', () => {
    it('allows execution when oracle price is unchanged and within slippage bounds', () => {
      const job: LiquidationJobData = {
        ...baseJobData,
        debtAmount: '1000000000',
        oraclePriceUsd: '100',
        currentOraclePriceUsd: '100', // Unchanged oracle price
        maxSlippageBps: 300, // 3% max slippage
      };

      const result = evaluateLiquidationDryRun(job);
      expect(result).toEqual({ safe: true });
    });

    it('allows execution when oracle price changes favorably (yields more or equal seized collateral)', () => {
      const job: LiquidationJobData = {
        ...baseJobData,
        debtAmount: '1000000000',
        oraclePriceUsd: '100', // Scan price
        currentOraclePriceUsd: '90', // Collateral price fell, liquidator seizes MORE collateral
        maxSlippageBps: 300,
      };

      const result = evaluateLiquidationDryRun(job);
      expect(result).toEqual({ safe: true });
    });

    it('allows execution when changing oracle price produces minor slippage within tolerance', () => {
      // Price increases from 1000 to 1020 (2% increase in collateral price -> ~1.96% fewer collateral seized)
      // 1.96% = 196 bps < 300 bps max tolerance
      const job: LiquidationJobData = {
        ...baseJobData,
        debtAmount: '1000000000',
        oraclePriceUsd: '1000',
        currentOraclePriceUsd: '1020',
        maxSlippageBps: 300,
      };

      const result = evaluateLiquidationDryRun(job);
      expect(result).toEqual({ safe: true });
    });

    it('rejects execution when changing oracle price produces slippage exceeding configured bounds', () => {
      // Price increases from 1000 to 1100 (10% increase -> ~9.09% fewer collateral seized = ~909 bps)
      // 909 bps > 300 bps max tolerance
      const job: LiquidationJobData = {
        ...baseJobData,
        debtAmount: '1000000000',
        oraclePriceUsd: '1000',
        currentOraclePriceUsd: '1100',
        maxSlippageBps: 300,
      };

      const result = evaluateLiquidationDryRun(job);
      expect(result.safe).toBe(false);
      expect((result as any).reason).toBe('slippage_exceeded');
      expect((result as any).details).toMatch(/Slippage .* exceeds max configured 300 bps/);
    });

    it('rejects execution when current seized collateral drops below configured minSeizedCollateral floor', () => {
      // Expected: 1000 * 11000 / (150 * 10000) = 7
      // Floor required: 10
      const job: LiquidationJobData = {
        ...baseJobData,
        debtAmount: '1000',
        currentOraclePriceUsd: 150,
        minSeizedCollateral: '10',
      };

      const result = evaluateLiquidationDryRun(job);
      expect(result.safe).toBe(false);
      expect((result as any).reason).toBe('slippage_exceeded');
      expect((result as any).details).toMatch(/is below minimum bound 10/);
    });

    it('supports passing dynamic currentOraclePrice into evaluateLiquidationDryRun', () => {
      const job: LiquidationJobData = {
        ...baseJobData,
        debtAmount: '1000000000',
        oraclePriceUsd: '1000',
        maxSlippageBps: 200,
      };

      // Fails with dynamic current oracle price = 1050 (5% slippage > 2%)
      const failedResult = evaluateLiquidationDryRun(job, Date.now(), 1050);
      expect(failedResult.safe).toBe(false);
      expect((failedResult as any).reason).toBe('slippage_exceeded');

      // Succeeds with dynamic current oracle price = 1010 (1% slippage <= 2%)
      const successResult = evaluateLiquidationDryRun(job, Date.now(), 1010);
      expect(successResult).toEqual({ safe: true });
    });
  });

  describe('LiquidationWorker execution rejection on slippage', () => {
    it('LiquidationWorker.process throws and rejects submission when slippage bounds are violated', async () => {
      const mockSigner = {
        publicKey: 'GKEEPER123',
        invokeContract: jest.fn().mockResolvedValue('TX_HASH'),
        server: { getAccount: jest.fn().mockResolvedValue({ sequence: '10' }) },
      };

      const worker = new LiquidationWorker(mockSigner as any);
      const mockJob = {
        id: 'job-slip-1',
        data: {
          ...baseJobData,
          debtAmount: '1000000000',
          oraclePriceUsd: '1000',
          currentOraclePriceUsd: '1200', // 20% price shift
          maxSlippageBps: 300, // 3% tolerance
        },
        attemptsMade: 0,
      } as Job<LiquidationJobData>;

      await expect(worker.process(mockJob)).rejects.toThrow('Liquidation blocked by dry-run policy: slippage_exceeded');
      expect(mockSigner.invokeContract).not.toHaveBeenCalled();
    });
  });
});
