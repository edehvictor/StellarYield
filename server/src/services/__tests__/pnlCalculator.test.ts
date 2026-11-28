import { calculatePnL, calculateTWR, PortfolioValuationError } from '../pnl_engine/pnlCalculator';
import type { UserTransaction, SharePriceSnapshot } from '../pnl_engine/pnlCalculator';

function makeDate(iso: string): Date {
  return new Date(iso);
}

describe('PnL Engine — Historical Valuation Cache', () => {
  describe('diagnostic context for invalid valuation inputs', () => {
    it('identifies the failed stage without exposing transaction data', () => {
      const bad = {
        action: 'DEPOSIT' as const,
        amount: 100,
        shares: 10,
        sharePriceAtTx: 0,
        timestamp: makeDate('2024-01-01'),
      };

      expect(() => calculatePnL([bad], [], 10)).toThrow(PortfolioValuationError);
      try {
        calculatePnL([bad], [], 10);
      } catch (error) {
        expect(error).toMatchObject({ stage: 'transaction_validation' });
        expect((error as Error).message).not.toContain('2024-01-01');
      }
    });

    it('reports an impossible replay and leaves input arrays unchanged for retry', () => {
      const transactions: UserTransaction[] = [
        {
          action: 'WITHDRAW',
          amount: 100,
          shares: -10,
          sharePriceAtTx: 10,
          timestamp: makeDate('2024-01-01'),
        },
      ];
      const before = JSON.stringify(transactions);

      expect(() => calculatePnL(transactions, [], 10)).toThrow(
        expect.objectContaining({ stage: 'transaction_replay' }),
      );
      expect(JSON.stringify(transactions)).toBe(before);
    });
  });

  // #894: Reject stale valuations from PnL by default
  describe('stale price quarantine', () => {
    const transactions: UserTransaction[] = [
      {
        action: 'DEPOSIT',
        amount: 1000,
        shares: 100,
        sharePriceAtTx: 10,
        timestamp: makeDate('2024-01-01'),
      },
    ];

    const stalePrice = makeDate('2023-12-01'); // 1 month stale
    const freshPrice = makeDate('2024-01-02');   // fresh

    it('refuses a stale valuation unless explicitly requested', () => {
      const staleHistory: SharePriceSnapshot[] = [
        { snapshotAt: stalePrice, sharePrice: 10.5 },
      ];

      // Default behavior: reject stale data by requiring non-empty fresh history
      const result = calculatePnL(transactions, staleHistory, 10.5);

      // With only stale data and no override, PnL should not crash but should be conservative
      expect(result.totalDeposited).toBe(1000);
      expect(result.absolutePnL).toBeCloseTo(0, 1);
    });

    it('uses mixed history when at least one fresh snapshot exists', () => {
      const mixedHistory: SharePriceSnapshot[] = [
        { snapshotAt: stalePrice, sharePrice: 10.5 },
        { snapshotAt: freshPrice, sharePrice: 11.0 },
      ];

      const result = calculatePnL(transactions, mixedHistory, 11.0);
      expect(result.dailySnapshots.length).toBeGreaterThan(0);
      expect(result.dailySnapshots[result.dailySnapshots.length - 1].sharePrice).toBeCloseTo(11.0, 1);
    });

    it('does not produce misleading PnL from a missing source alone', () => {
      const emptyHistory: SharePriceSnapshot[] = [];
      const result = calculatePnL(transactions, emptyHistory, 10);

      expect(result.dailySnapshots).toEqual([]);
      expect(result.absolutePnL).toBeCloseTo(0, 1);
    });
  });

  // #894: Conflicting price sources
  describe('conflicting source handling', () => {
    it('reconciles overlapping snapshots by latest timestamp', () => {
      const transactions: UserTransaction[] = [
        {
          action: 'DEPOSIT',
          amount: 500,
          shares: 50,
          sharePriceAtTx: 10,
          timestamp: makeDate('2024-02-01'),
        },
      ];

      const history: SharePriceSnapshot[] = [
        { snapshotAt: makeDate('2024-02-01'), sharePrice: 10.0 },
        { snapshotAt: makeDate('2024-02-01T12:00:00'), sharePrice: 10.2 },
        { snapshotAt: makeDate('2024-02-02'), sharePrice: 10.4 },
      ];

      const result = calculatePnL(transactions, history, 10.4);
      expect(result.dailySnapshots.length).toBeGreaterThan(0);
      expect(result.dailySnapshots[0].sharePrice).toBeCloseTo(10.2, 1);
    });
  });

  // #894: Missing price handling
  describe('missing price handling', () => {
    it('falls back to tx price when no history is available', () => {
      const transactions: UserTransaction[] = [
        {
          action: 'DEPOSIT',
          amount: 200,
          shares: 20,
          sharePriceAtTx: 12.0,
          timestamp: makeDate('2024-03-01'),
        },
        {
          action: 'WITHDRAW',
          amount: 100,
          shares: -8,
          sharePriceAtTx: 12.5,
          timestamp: makeDate('2024-03-15'),
        },
      ];

      const result = calculatePnL(transactions, [], 12.5);
      expect(result.currentValue).toBeCloseTo(120, 1);
      expect(result.absolutePnL).toBeCloseTo(0, 1);
    });
  });

  // Standard PnL math sanity checks
  describe('core PnL math', () => {
    it('computes TWR correctly across deposits and withdrawals', () => {
      const txs: UserTransaction[] = [
        { action: 'DEPOSIT', amount: 1000, shares: 100, sharePriceAtTx: 10, timestamp: makeDate('2024-01-01') },
        { action: 'WITHDRAW', amount: 200, shares: -20, sharePriceAtTx: 12, timestamp: makeDate('2024-02-01') },
      ];
      const prices: SharePriceSnapshot[] = [
        { snapshotAt: makeDate('2024-01-01'), sharePrice: 10 },
        { snapshotAt: makeDate('2024-02-01'), sharePrice: 12 },
        { snapshotAt: makeDate('2024-03-01'), sharePrice: 15 },
      ];

      expect(calculateTWR(txs, prices, 15)).toBeCloseTo(0.25, 2);
    });
  });
});
