import { describe, it, expect } from 'vitest';
import {
  RECONCILIATION_FIXTURES,
  validateReconciliationResult,
  explainVariance,
  type ReconciliationFixture,
} from '../../../../../shared/test-fixtures/reconciliationFixtures';

function serverSeverityToClientSeverity(
  severity: 'matched' | 'small' | 'material' | 'critical' | 'unavailable',
): 'ok' | 'warning' | 'critical' {
  switch (severity) {
    case 'matched':
      return 'ok';
    case 'small':
    case 'unavailable':
      return 'warning';
    case 'material':
    case 'critical':
      return 'critical';
  }
}

function formatDelta(delta: number | null): string | number | null {
  if (delta === null) return null;
  return delta;
}

describe('Portfolio Reconciliation Contract Tests – Client', () => {
  describe('severity mapping from server to client', () => {
    it('maps "matched" to "ok"', () => {
      expect(serverSeverityToClientSeverity('matched')).toBe('ok');
    });

    it('maps "small" to "warning"', () => {
      expect(serverSeverityToClientSeverity('small')).toBe('warning');
    });

    it('maps "material" to "critical"', () => {
      expect(serverSeverityToClientSeverity('material')).toBe('critical');
    });

    it('maps "critical" to "critical"', () => {
      expect(serverSeverityToClientSeverity('critical')).toBe('critical');
    });

    it('maps "unavailable" to "warning"', () => {
      expect(serverSeverityToClientSeverity('unavailable')).toBe('warning');
    });
  });

  describe('shared fixture contracts for client presentation', () => {
    for (const fixture of RECONCILIATION_FIXTURES) {
      it(`"${fixture.description}" – row count matches`, () => {
        expect(fixture.expectedOutput.rows.length).toBe(fixture.expectedOutput.rowCount);
      });

      it(`"${fixture.description}" – client severity is derivable`, () => {
        for (const row of fixture.expectedOutput.rows) {
          const clientSev = serverSeverityToClientSeverity(row.severity);
          expect(['ok', 'warning', 'critical']).toContain(clientSev);
        }
      });
    }
  });

  describe('variance explanation rendering', () => {
    it('matched row produces "matches expected" explanation', () => {
      const result = explainVariance({
        asset: 'USDC',
        expected: 10_000,
        observed: 10_000,
        delta: 0,
        deltaPct: 0,
        severity: 'matched',
      });
      expect(result.explanation).toContain('matches expected');
      expect(result.asset).toBe('USDC');
    });

    it('unavailable row produces "No balance data" explanation', () => {
      const result = explainVariance({
        asset: 'BTC',
        expected: 5,
        observed: null,
        delta: null,
        deltaPct: null,
        severity: 'unavailable',
      });
      expect(result.explanation).toContain('No balance data');
    });

    it('small drift includes percentage in explanation', () => {
      const result = explainVariance({
        asset: 'USDC',
        expected: 10_000,
        observed: 9_800,
        delta: -200,
        deltaPct: -0.02,
        severity: 'small',
      });
      expect(result.explanation).toContain('-2.00%');
      expect(result.explanation).toContain('minor drift');
    });

    it('material drift explains investigation needed', () => {
      const result = explainVariance({
        asset: 'XLM',
        expected: 50_000,
        observed: 44_000,
        delta: -6000,
        deltaPct: -0.12,
        severity: 'material',
      });
      expect(result.explanation).toContain('investigate');
    });

    it('critical variance signals immediate action', () => {
      const result = explainVariance({
        asset: 'ETH',
        expected: 100,
        observed: 80,
        delta: -20,
        deltaPct: -0.2,
        severity: 'critical',
      });
      expect(result.explanation).toContain('immediate investigation');
    });
  });

  describe('client-side delta display formatting', () => {
    it('formats null delta as null', () => {
      expect(formatDelta(null)).toBeNull();
    });

    it('formats zero delta correctly', () => {
      expect(formatDelta(0)).toBe(0);
    });

    it('formats negative delta correctly', () => {
      expect(formatDelta(-60)).toBe(-60);
    });

    it('formats positive delta correctly', () => {
      expect(formatDelta(1600)).toBe(1600);
    });
  });

  describe('typed error handling', () => {
    it('validateReconciliationResult detects missing rows', () => {
      const fixture = RECONCILIATION_FIXTURES[0];
      const { valid, errors } = validateReconciliationResult(fixture, []);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('Expected'))).toBe(true);
    });

    it('validateReconciliationResult detects severity mismatch', () => {
      const fixture = RECONCILIATION_FIXTURES[0];
      const { valid, errors } = validateReconciliationResult(fixture, [
        { asset: 'USDC', severity: 'critical', delta: 0 },
      ]);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('severity'))).toBe(true);
    });

    it('validateReconciliationResult passes for correct data', () => {
      const fixture = RECONCILIATION_FIXTURES[0];
      const { valid, errors } = validateReconciliationResult(fixture, [
        { asset: 'USDC', severity: 'matched', delta: 0 },
      ]);
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    });
  });
});
