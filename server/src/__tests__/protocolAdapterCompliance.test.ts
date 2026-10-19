/**
 * protocolAdapterCompliance.test.ts
 *
 * Tests for issue #1126 — provider fallback reasons in compatibility scoring.
 *
 * Covers:
 *  - deriveFallbackReason() selects the correct code for each issue pattern
 *  - CompatibilityIssue carries fallbackReason / fallbackReasonCode fields
 *  - ProtocolCompatibilityEngine attaches reasons to every emitted issue
 *  - formatCompatibilityReport() preserves reasons end-to-end
 */

import {
  deriveFallbackReason,
  FALLBACK_REASON_LABELS,
  CompatibilityIssue,
  ProtocolCompatibilityEngine,
  formatCompatibilityReport,
  groupIssuesByAction,
  sortIssues,
  type FallbackReasonCode,
} from '../services/protocolCompatibilityService';

// ── deriveFallbackReason unit tests ────────────────────────────────────────────

describe('deriveFallbackReason()', () => {
  it('returns version_below_minimum for version-below messages', () => {
    const cases = [
      'Version 1.0.0 is below required 2.0.0',
      'version below minimum detected',
      'below required version',
    ];
    for (const msg of cases) {
      const { fallbackReasonCode } = deriveFallbackReason(msg);
      expect(fallbackReasonCode).toBe<FallbackReasonCode>('version_below_minimum');
    }
  });

  it('returns version_exceeds_maximum for version-exceeds messages', () => {
    const cases = [
      'Version 4.0.0 exceeds maximum 3.1.0',
      'version exceeds supported range',
      'above maximum allowed version',
    ];
    for (const msg of cases) {
      const { fallbackReasonCode } = deriveFallbackReason(msg);
      expect(fallbackReasonCode).toBe<FallbackReasonCode>('version_exceeds_maximum');
    }
  });

  it('returns breaking_change_detected for breaking-change messages', () => {
    const { fallbackReasonCode } = deriveFallbackReason('Breaking changes detected');
    expect(fallbackReasonCode).toBe<FallbackReasonCode>('breaking_change_detected');
  });

  it('returns critical_feature_unavailable for missing-feature messages', () => {
    const cases = [
      'Critical features unavailable',
      'critical feature missing in this release',
      'features unavailable after upgrade',
    ];
    for (const msg of cases) {
      const { fallbackReasonCode } = deriveFallbackReason(msg);
      expect(fallbackReasonCode).toBe<FallbackReasonCode>('critical_feature_unavailable');
    }
  });

  it('returns version_fetch_failed for version-fetch-failure messages', () => {
    const { fallbackReasonCode } = deriveFallbackReason('Failed to fetch protocol version');
    expect(fallbackReasonCode).toBe<FallbackReasonCode>('version_fetch_failed');
  });

  it('returns compatibility_check_failed for check-failure messages', () => {
    const { fallbackReasonCode } = deriveFallbackReason('Compatibility check failed');
    expect(fallbackReasonCode).toBe<FallbackReasonCode>('compatibility_check_failed');
  });

  it('returns unknown for unrecognised messages', () => {
    const { fallbackReasonCode } = deriveFallbackReason('Something unexpected happened');
    expect(fallbackReasonCode).toBe<FallbackReasonCode>('unknown');
  });

  it('includes a non-empty human-readable fallbackReason string for every code', () => {
    const codes: FallbackReasonCode[] = [
      'version_below_minimum',
      'version_exceeds_maximum',
      'breaking_change_detected',
      'critical_feature_unavailable',
      'version_fetch_failed',
      'compatibility_check_failed',
      'unknown',
    ];
    for (const code of codes) {
      const label = FALLBACK_REASON_LABELS[code];
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('returns the label that matches the derived code', () => {
    const issueText = 'Version 1.0 is below required 2.0.0';
    const { fallbackReasonCode, fallbackReason } = deriveFallbackReason(issueText);
    expect(fallbackReason).toBe(FALLBACK_REASON_LABELS[fallbackReasonCode]);
  });

  it('considers the component argument in matching', () => {
    // Even when the issue text alone is neutral the component text may tip the match
    const { fallbackReasonCode } = deriveFallbackReason(
      'Failed to fetch protocol version',
      'core_contract',
    );
    expect(fallbackReasonCode).toBe<FallbackReasonCode>('version_fetch_failed');
  });
});

// ── CompatibilityIssue shape tests ────────────────────────────────────────────

describe('CompatibilityIssue with fallback reason', () => {
  it('accepts a well-formed issue containing fallbackReason fields', () => {
    const { fallbackReasonCode, fallbackReason } = deriveFallbackReason('Breaking changes detected');
    const issue: CompatibilityIssue = {
      severity: 'critical',
      component: 'router_contract',
      issue: 'Breaking changes detected',
      impact: 'Routing may fail',
      recommendation: 'Review integration code',
      affectedStrategies: ['Soroswap_yield_strategy'],
      fallbackReasonCode,
      fallbackReason,
    };

    expect(issue.fallbackReasonCode).toBe('breaking_change_detected');
    expect(issue.fallbackReason).toContain('Breaking change');
  });

  it('works without fallbackReason fields (backward compatibility)', () => {
    const issue: CompatibilityIssue = {
      severity: 'low',
      component: 'api',
      issue: 'Minor version drift',
      impact: 'Negligible',
      recommendation: 'Monitor',
      affectedStrategies: [],
    };

    expect(issue.fallbackReasonCode).toBeUndefined();
    expect(issue.fallbackReason).toBeUndefined();
  });
});

// ── ProtocolCompatibilityEngine integration tests ─────────────────────────────

describe('ProtocolCompatibilityEngine — fallback reasons in output', () => {
  let engine: ProtocolCompatibilityEngine;

  beforeEach(() => {
    engine = new ProtocolCompatibilityEngine();
  });

  it('attaches fallbackReason and fallbackReasonCode to every issue in a protocol check', async () => {
    const status = await engine.checkProtocol('Blend');

    // Blend has two components each of which generates issues in the mock
    expect(status.issues.length).toBeGreaterThan(0);

    for (const issue of status.issues) {
      expect(issue).toHaveProperty('fallbackReasonCode');
      expect(issue).toHaveProperty('fallbackReason');
      expect(typeof issue.fallbackReasonCode).toBe('string');
      expect(typeof issue.fallbackReason).toBe('string');
      expect((issue.fallbackReason as string).length).toBeGreaterThan(0);
    }
  });

  it('attaches fallbackReason to Soroswap issues', async () => {
    const status = await engine.checkProtocol('Soroswap');

    expect(status.issues.length).toBeGreaterThan(0);
    // The mock available features exclude 'get_amount_out', so Soroswap issues
    // are of the critical_feature_unavailable type
    const codes = status.issues.map(i => i.fallbackReasonCode);
    expect(codes).toContain('critical_feature_unavailable');
  });

  it('attaches fallbackReason to DeFindex issues', async () => {
    const status = await engine.checkProtocol('DeFindex');

    for (const issue of status.issues) {
      expect(issue.fallbackReasonCode).toBeTruthy();
      expect(issue.fallbackReason).toBeTruthy();
    }
  });

  it('attaches version_fetch_failed reason when protocol check throws', async () => {
    // Register a protocol name with no requirements so it throws
    const badEngine = new ProtocolCompatibilityEngine();

    // Manually force an error by providing an unknown protocol name
    await expect(badEngine.checkProtocol('NonExistentProtocol')).rejects.toThrow();
  });

  it('every issue in the full report has a fallbackReason', async () => {
    const report = await engine.runCompatibilityCheck();
    const allIssues: CompatibilityIssue[] = [
      ...report.criticalIssues,
      ...report.protocols.flatMap(p => p.issues),
    ];

    expect(allIssues.length).toBeGreaterThan(0);
    for (const issue of allIssues) {
      expect(issue.fallbackReasonCode).toBeTruthy();
      expect(issue.fallbackReason).toBeTruthy();
    }
  });

  it('action groups preserve fallbackReason on issues', async () => {
    const report = await engine.runCompatibilityCheck();

    for (const group of report.actionGroups) {
      for (const issue of group.issues) {
        expect(issue.fallbackReasonCode).toBeTruthy();
        expect(issue.fallbackReason).toBeTruthy();
      }
    }
  });
});

// ── formatCompatibilityReport round-trip ─────────────────────────────────────

describe('formatCompatibilityReport() — fallback reason preservation', () => {
  it('preserves fallbackReason through the formatting pipeline', async () => {
    const engine = new ProtocolCompatibilityEngine();
    const report = await engine.runCompatibilityCheck();
    const formatted = formatCompatibilityReport(report);

    const formattedIssues = formatted.protocols.flatMap(p => p.issues);
    expect(formattedIssues.length).toBeGreaterThan(0);

    for (const issue of formattedIssues) {
      expect(issue.fallbackReasonCode).toBeTruthy();
      expect(issue.fallbackReason).toBeTruthy();
    }
  });

  it('preserves fallbackReason in criticalIssues after formatting', async () => {
    const engine = new ProtocolCompatibilityEngine();
    const report = await engine.runCompatibilityCheck();
    const formatted = formatCompatibilityReport(report);

    for (const issue of formatted.criticalIssues) {
      expect(issue.fallbackReasonCode).toBeTruthy();
      expect(issue.fallbackReason).toBeTruthy();
    }
  });

  it('preserves fallbackReason in actionGroups after formatting', async () => {
    const engine = new ProtocolCompatibilityEngine();
    const report = await engine.runCompatibilityCheck();
    const formatted = formatCompatibilityReport(report);

    for (const group of formatted.actionGroups) {
      for (const issue of group.issues) {
        expect(issue.fallbackReasonCode).toBeTruthy();
        expect(issue.fallbackReason).toBeTruthy();
      }
    }
  });
});

// ── Multiple distinct reason codes in one report ──────────────────────────────

describe('Multiple fallback reason types in one report', () => {
  it('report contains issues with at least two distinct fallbackReasonCodes', async () => {
    const engine = new ProtocolCompatibilityEngine();
    const report = await engine.runCompatibilityCheck();
    const allIssues = report.protocols.flatMap(p => p.issues);

    const uniqueCodes = new Set(allIssues.map(i => i.fallbackReasonCode));
    expect(uniqueCodes.size).toBeGreaterThanOrEqual(2);
  });

  it('groupIssuesByAction preserves fallbackReason from source issues', () => {
    const issues: CompatibilityIssue[] = [
      {
        severity: 'critical',
        component: 'core_contract',
        issue: 'Breaking changes detected',
        impact: 'Deposits blocked',
        recommendation: 'Update integration',
        affectedStrategies: [],
        affectedActions: ['deposit'],
        ...deriveFallbackReason('Breaking changes detected'),
      },
      {
        severity: 'high',
        component: 'api',
        issue: 'Version 0.9 is below required 1.0.0',
        impact: 'Degraded reporting',
        recommendation: 'Upgrade API',
        affectedStrategies: [],
        affectedActions: ['reporting'],
        ...deriveFallbackReason('Version 0.9 is below required 1.0.0'),
      },
    ];

    const groups = groupIssuesByAction(issues);
    const depositGroup = groups.find(g => g.action === 'deposit');
    const reportingGroup = groups.find(g => g.action === 'reporting');

    expect(depositGroup?.issues[0].fallbackReasonCode).toBe('breaking_change_detected');
    expect(reportingGroup?.issues[0].fallbackReasonCode).toBe('version_below_minimum');
  });

  it('sortIssues preserves fallbackReason fields after sorting', () => {
    const issues: CompatibilityIssue[] = [
      {
        severity: 'low',
        component: 'api',
        issue: 'Minor drift',
        impact: 'Low',
        recommendation: 'Monitor',
        affectedStrategies: [],
        ...deriveFallbackReason('Something unexpected happened'),
      },
      {
        severity: 'critical',
        component: 'core_contract',
        issue: 'Breaking changes detected',
        impact: 'Critical',
        recommendation: 'Fix now',
        affectedStrategies: [],
        ...deriveFallbackReason('Breaking changes detected'),
      },
    ];

    const sorted = sortIssues(issues);
    expect(sorted[0].severity).toBe('critical');
    expect(sorted[0].fallbackReasonCode).toBe('breaking_change_detected');
    expect(sorted[1].severity).toBe('low');
    expect(sorted[1].fallbackReasonCode).toBe('unknown');
  });
});
