import { AlertSeverity, DEFAULT_ALERT_SEVERITY, normalizeSeverity } from '../utils/alertSeverity';

describe('alertSeverity', () => {
  describe('normalizeSeverity — canonical values', () => {
    it.each([
      ['LOW', AlertSeverity.LOW],
      ['MEDIUM', AlertSeverity.MEDIUM],
      ['HIGH', AlertSeverity.HIGH],
      ['CRITICAL', AlertSeverity.CRITICAL],
    ])('passes through the canonical value %s', (input, expected) => {
      expect(normalizeSeverity(input)).toBe(expected);
    });
  });

  describe('normalizeSeverity — case-insensitivity', () => {
    it.each([
      ['low', AlertSeverity.LOW],
      ['Low', AlertSeverity.LOW],
      ['critical', AlertSeverity.CRITICAL],
      ['Critical', AlertSeverity.CRITICAL],
      ['CRITICAL', AlertSeverity.CRITICAL],
      ['hIgH', AlertSeverity.HIGH],
      ['MEDIUM', AlertSeverity.MEDIUM],
      ['medium', AlertSeverity.MEDIUM],
    ])('normalizes %s to %s regardless of case', (input, expected) => {
      expect(normalizeSeverity(input)).toBe(expected);
    });
  });

  describe('normalizeSeverity — known aliases', () => {
    it.each([
      ['info', AlertSeverity.LOW],
      ['informational', AlertSeverity.LOW],
      ['notice', AlertSeverity.LOW],
      ['debug', AlertSeverity.LOW],
      ['moderate', AlertSeverity.MEDIUM],
      ['warning', AlertSeverity.MEDIUM],
      ['warn', AlertSeverity.MEDIUM],
      ['major', AlertSeverity.HIGH],
      ['error', AlertSeverity.HIGH],
      ['elevated', AlertSeverity.HIGH],
      ['crit', AlertSeverity.CRITICAL],
      ['fatal', AlertSeverity.CRITICAL],
      ['emergency', AlertSeverity.CRITICAL],
      ['severe', AlertSeverity.CRITICAL],
    ])('maps alias "%s" to %s', (alias, expected) => {
      expect(normalizeSeverity(alias)).toBe(expected);
    });

    it('maps aliases case-insensitively', () => {
      expect(normalizeSeverity('WARNING')).toBe(AlertSeverity.MEDIUM);
      expect(normalizeSeverity('Error')).toBe(AlertSeverity.HIGH);
      expect(normalizeSeverity('EMERGENCY')).toBe(AlertSeverity.CRITICAL);
    });
  });

  describe('normalizeSeverity — whitespace handling', () => {
    it('trims surrounding whitespace before matching', () => {
      expect(normalizeSeverity('  critical  ')).toBe(AlertSeverity.CRITICAL);
      expect(normalizeSeverity('\thigh\n')).toBe(AlertSeverity.HIGH);
    });
  });

  describe('normalizeSeverity — unknown/invalid input fallback', () => {
    it('falls back to the default severity for an unrecognized string', () => {
      expect(normalizeSeverity('sev1')).toBe(DEFAULT_ALERT_SEVERITY);
      expect(normalizeSeverity('banana')).toBe(DEFAULT_ALERT_SEVERITY);
    });

    it('falls back to the default severity for an empty string', () => {
      expect(normalizeSeverity('')).toBe(DEFAULT_ALERT_SEVERITY);
      expect(normalizeSeverity('   ')).toBe(DEFAULT_ALERT_SEVERITY);
    });

    it('falls back to the default severity for null/undefined', () => {
      expect(normalizeSeverity(null)).toBe(DEFAULT_ALERT_SEVERITY);
      expect(normalizeSeverity(undefined)).toBe(DEFAULT_ALERT_SEVERITY);
    });

    it('never throws for arbitrary garbage input', () => {
      expect(() => normalizeSeverity('!!!not-a-severity###')).not.toThrow();
      expect(normalizeSeverity('!!!not-a-severity###')).toBe(DEFAULT_ALERT_SEVERITY);
    });
  });

  describe('AlertSeverity enum', () => {
    it('exposes exactly the four canonical levels', () => {
      expect(Object.values(AlertSeverity).sort()).toEqual(
        ['CRITICAL', 'HIGH', 'LOW', 'MEDIUM'].sort()
      );
    });
  });
});
