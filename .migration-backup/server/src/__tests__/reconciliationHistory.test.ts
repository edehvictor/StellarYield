import {
  PortfolioReconcileService,
  resetReconciliationStore,
  getReconciliationStore,
  persistReconciliationEvent,
  queryReconciliationHistory,
  type ReconciliationHistoryEntry,
} from '../services/portfolioReconcileService';

describe('Durable Portfolio Reconciliation History', () => {
  const mockPrisma = {
    vaultBalance: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetReconciliationStore();
  });

  describe('persistReconciliationEvent', () => {
    it('stores a reconciliation event in the durable store', () => {
      const entry: ReconciliationHistoryEntry = {
        id: 'recon_1',
        walletAddress: 'wallet-A',
        timestamp: '2025-06-01T10:00:00Z',
        status: 'success',
        changeCount: 2,
        mismatchCount: 0,
        changes: [],
        mismatches: [],
      };
      persistReconciliationEvent(entry);

      const store = getReconciliationStore();
      expect(store).toHaveLength(1);
      expect(store[0].id).toBe('recon_1');
    });

    it('stores multiple events', () => {
      persistReconciliationEvent({
        id: 'r1', walletAddress: 'w1', timestamp: '2025-06-01T10:00:00Z',
        status: 'success', changeCount: 0, mismatchCount: 0, changes: [], mismatches: [],
      });
      persistReconciliationEvent({
        id: 'r2', walletAddress: 'w1', timestamp: '2025-06-01T11:00:00Z',
        status: 'partial', changeCount: 1, mismatchCount: 1, changes: [], mismatches: [],
      });

      expect(getReconciliationStore()).toHaveLength(2);
    });

    it('stores events with error details', () => {
      persistReconciliationEvent({
        id: 'r-err', walletAddress: 'w1', timestamp: '2025-06-01T12:00:00Z',
        status: 'failed', changeCount: 0, mismatchCount: 0, changes: [], mismatches: [],
        error: 'Provider timeout',
      });

      const store = getReconciliationStore();
      expect(store[0].error).toBe('Provider timeout');
    });
  });

  describe('queryReconciliationHistory', () => {
    beforeEach(() => {
      const entries: ReconciliationHistoryEntry[] = [
        {
          id: 'r1', walletAddress: 'wallet-A', timestamp: '2025-06-01T10:00:00Z',
          status: 'success', changeCount: 0, mismatchCount: 0, changes: [], mismatches: [],
        },
        {
          id: 'r2', walletAddress: 'wallet-A', timestamp: '2025-06-02T10:00:00Z',
          status: 'partial', changeCount: 1, mismatchCount: 1,
          changes: [{ type: 'updated' as const, position: { assetId: 'USDC', amount: 1000, vaultId: 'v1', protocol: 'blend' }, previousAmount: 900, currentAmount: 1000 }],
          mismatches: [{ assetId: 'USDC', chainValue: 1000, cachedValue: 900, discrepancy: 100, severity: 'warning' as const }],
        },
        {
          id: 'r3', walletAddress: 'wallet-A', timestamp: '2025-06-03T10:00:00Z',
          status: 'failed', changeCount: 0, mismatchCount: 0, changes: [], mismatches: [],
          error: 'Network error',
        },
        {
          id: 'r4', walletAddress: 'wallet-B', timestamp: '2025-06-02T10:00:00Z',
          status: 'success', changeCount: 0, mismatchCount: 0, changes: [], mismatches: [],
        },
      ];
      entries.forEach(persistReconciliationEvent);
    });

    it('filters by wallet address', () => {
      const results = queryReconciliationHistory('wallet-A');
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.walletAddress === 'wallet-A')).toBe(true);
    });

    it('returns empty for unknown wallet', () => {
      expect(queryReconciliationHistory('unknown')).toEqual([]);
    });

    it('filters by status', () => {
      const results = queryReconciliationHistory('wallet-A', { status: 'failed' });
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
    });

    it('respects limit', () => {
      const results = queryReconciliationHistory('wallet-A', { limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('sorts by timestamp descending (newest first)', () => {
      const results = queryReconciliationHistory('wallet-A');
      expect(results[0].id).toBe('r3');
      expect(results[2].id).toBe('r1');
    });

    it('filters by date range', () => {
      const results = queryReconciliationHistory('wallet-A', {
        startDate: '2025-06-02T00:00:00Z',
        endDate: '2025-06-02T23:59:59Z',
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('r2');
    });

    it('includes variance details (changes and mismatches)', () => {
      const results = queryReconciliationHistory('wallet-A', { status: 'partial' });
      expect(results).toHaveLength(1);
      expect(results[0].changes).toHaveLength(1);
      expect(results[0].mismatches).toHaveLength(1);
      expect(results[0].mismatches[0].discrepancy).toBe(100);
    });
  });

  describe('PortfolioReconcileService integration', () => {
    let service: PortfolioReconcileService;

    beforeEach(() => {
      service = new PortfolioReconcileService(mockPrisma);
    });

    it('persists reconciliation events on successful reconcile', async () => {
      mockPrisma.vaultBalance.findUnique.mockResolvedValue(null);

      await service.reconcilePortfolio('test-wallet');

      const history = await service.getReconciliationHistory('test-wallet');
      expect(history).toHaveLength(1);
      expect(history[0].walletAddress).toBe('test-wallet');
      expect(history[0].status).toBe('success');
    });

    it('persists failed reconciliation events', async () => {
      mockPrisma.vaultBalance.findUnique.mockRejectedValue(new Error('DB down'));

      await service.reconcilePortfolio('fail-wallet');

      const history = await service.getReconciliationHistory('fail-wallet');
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('failed');
      expect(history[0].error).toContain('DB down');
    });

    it('accumulates history across multiple reconciliations', async () => {
      mockPrisma.vaultBalance.findUnique.mockResolvedValue(null);

      await service.reconcilePortfolio('multi-wallet');
      await service.reconcilePortfolio('multi-wallet');
      await service.reconcilePortfolio('multi-wallet');

      const history = await service.getReconciliationHistory('multi-wallet');
      expect(history).toHaveLength(3);
    });

    it('respects limit in getReconciliationHistory', async () => {
      mockPrisma.vaultBalance.findUnique.mockResolvedValue(null);

      await service.reconcilePortfolio('limit-wallet');
      await service.reconcilePortfolio('limit-wallet');
      await service.reconcilePortfolio('limit-wallet');

      const history = await service.getReconciliationHistory('limit-wallet', 2);
      expect(history).toHaveLength(2);
    });
  });
});
