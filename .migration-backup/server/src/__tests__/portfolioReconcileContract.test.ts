import {
  RECONCILIATION_FIXTURES,
  validateReconciliationResult,
  explainVariance,
} from '../../../shared/test-fixtures/reconciliationFixtures';
import { reconcilePortfolio, ReconcileRow } from '../services/portfolioReconcileService';

describe('Portfolio Reconciliation Contract Tests – Server', () => {
  describe('reconcilePortfolio against shared fixtures', () => {
    for (const fixture of RECONCILIATION_FIXTURES) {
      it(fixture.description, () => {
        const rows = reconcilePortfolio(fixture.input.positions, fixture.input.balances);
        const { valid, errors } = validateReconciliationResult(fixture, rows);
        expect(errors).toEqual([]);
        expect(valid).toBe(true);
      });
    }
  });

  describe('severity boundaries', () => {
    it('assigns "matched" for <1% drift', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'A', expected: 10_000 }],
        [{ provider: 'P', asset: 'A', balance: 9_950 }],
      );
      expect(rows[0].severity).toBe('matched');
    });

    it('assigns "small" for 1-5% drift', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'A', expected: 10_000 }],
        [{ provider: 'P', asset: 'A', balance: 9_700 }],
      );
      expect(rows[0].severity).toBe('small');
    });

    it('assigns "material" for 5-15% drift', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'A', expected: 10_000 }],
        [{ provider: 'P', asset: 'A', balance: 9_000 }],
      );
      expect(rows[0].severity).toBe('material');
    });

    it('assigns "critical" for >15% drift', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'A', expected: 10_000 }],
        [{ provider: 'P', asset: 'A', balance: 8_000 }],
      );
      expect(rows[0].severity).toBe('critical');
    });

    it('assigns "unavailable" when no provider data', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'A', expected: 10_000 }],
        [],
      );
      expect(rows[0].severity).toBe('unavailable');
      expect(rows[0].observed).toBeNull();
      expect(rows[0].delta).toBeNull();
    });
  });

  describe('delta calculations', () => {
    it('computes correct delta and deltaPct', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'X', expected: 1000 }],
        [{ provider: 'P', asset: 'X', balance: 940 }],
      );
      expect(rows[0].delta).toBe(-60);
      expect(rows[0].deltaPct).toBeCloseTo(-0.06, 4);
    });

    it('aggregates balances from multiple providers', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'X', expected: 1000 }],
        [
          { provider: 'P1', asset: 'X', balance: 500 },
          { provider: 'P2', asset: 'X', balance: 500 },
        ],
      );
      expect(rows[0].observed).toBe(1000);
      expect(rows[0].delta).toBe(0);
      expect(rows[0].severity).toBe('matched');
    });

    it('handles zero expected amount', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'Z', expected: 0 }],
        [{ provider: 'P', asset: 'Z', balance: 0 }],
      );
      expect(rows[0].delta).toBe(0);
      expect(rows[0].severity).toBe('matched');
    });
  });

  describe('variance explanations', () => {
    it('explains matched variance', () => {
      const explanation = explainVariance({
        asset: 'USDC', expected: 10_000, observed: 10_000, delta: 0, deltaPct: 0, severity: 'matched',
      });
      expect(explanation.explanation).toContain('matches expected');
    });

    it('explains unavailable variance', () => {
      const explanation = explainVariance({
        asset: 'BTC', expected: 5, observed: null, delta: null, deltaPct: null, severity: 'unavailable',
      });
      expect(explanation.explanation).toContain('No balance data');
    });

    it('explains material variance', () => {
      const explanation = explainVariance({
        asset: 'XLM', expected: 50_000, observed: 44_000, delta: -6000, deltaPct: -0.12, severity: 'material',
      });
      expect(explanation.explanation).toContain('material variance');
      expect(explanation.explanation).toContain('-12.00%');
    });

    it('explains critical variance', () => {
      const explanation = explainVariance({
        asset: 'ETH', expected: 100, observed: 80, delta: -20, deltaPct: -0.2, severity: 'critical',
      });
      expect(explanation.explanation).toContain('critical variance');
      expect(explanation.explanation).toContain('immediate investigation');
    });
  });

  describe('typed error handling', () => {
    it('returns empty array for empty positions', () => {
      const rows = reconcilePortfolio([], []);
      expect(rows).toEqual([]);
    });

    it('handles positions with undefined balance gracefully', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'A', expected: 100 }],
        [{ provider: 'P', asset: 'A', balance: undefined }],
      );
      expect(rows[0].severity).toBe('unavailable');
    });

    it('each row has all required fields', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'USDC', expected: 1000 }],
        [{ provider: 'P', asset: 'USDC', balance: 1000 }],
      );
      const row = rows[0];
      expect(row).toHaveProperty('asset');
      expect(row).toHaveProperty('expected');
      expect(row).toHaveProperty('observed');
      expect(row).toHaveProperty('delta');
      expect(row).toHaveProperty('deltaPct');
      expect(row).toHaveProperty('severity');
    });
  });
});
