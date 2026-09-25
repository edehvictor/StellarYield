import { buildApyConfidenceExplanation } from '../apyConfidenceExplanationService';
import { yieldQuorumService } from '../yieldQuorumService';

function fullInputs() {
  return {
    volatilityPct: 0.5,
    dataCompleteness: 1,
    modelFit: 0.85,
    historyCoverage: 1,
    coverageDecay: 1,
    coverageReasons: [],
  };
}

describe('buildApyConfidenceExplanation', () => {
  test('main path: agreeing fresh sources produce a high explanation with sorted rows', () => {
    const now = new Date().toISOString();
    const quorumStatus = yieldQuorumService.evaluateQuorum('Blend', [
      { provider: 'YieldWatch', apy: 6.8, fetchedAt: now },
      { provider: 'DeFiLlama', apy: 6.5, fetchedAt: now },
      { provider: 'StellarExpert', apy: 6.3, fetchedAt: now },
    ]);

    const explanation = buildApyConfidenceExplanation({
      protocol: 'Blend',
      confidenceInputs: fullInputs(),
      quorumStatus,
      confidence: 0.8,
      forecastApy: 6.5,
    });

    expect(explanation.protocol).toBe('Blend');
    expect(explanation.level).toBe('high');
    expect(explanation.quorumMet).toBe(true);
    expect(explanation.sources.map((s) => s.provider)).toEqual([
      'DeFiLlama',
      'StellarExpert',
      'YieldWatch',
    ]);
    expect(explanation.sources.every((s) => s.status === 'fresh')).toBe(true);
    expect(explanation.factors.map((f) => f.key)).toEqual(
      expect.arrayContaining(['volatility', 'data-completeness', 'model-fit', 'history-coverage', 'source-quorum']),
    );
    expect(explanation.summary).toMatch(/high/i);
    // No raw reason codes leak into user-facing strings.
    for (const row of explanation.sources) {
      expect(row.detail).not.toMatch(/quorum_not_met|source_failing/);
    }
  });

  test('edge (a): quorum not met degrades to low with fallback messages', () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // One stale source only: quorum (min 2) cannot be met.
    const quorumStatus = yieldQuorumService.evaluateQuorum('Blend', [
      { provider: 'LonelyFeed', apy: 6.5, fetchedAt: stale },
    ]);
    expect(quorumStatus.isMet).toBe(false);

    const explanation = buildApyConfidenceExplanation({
      protocol: 'Blend',
      confidenceInputs: {
        ...fullInputs(),
        dataCompleteness: 0.2,
        modelFit: 0.1,
      },
      quorumStatus,
      confidence: 0.2,
      forecastApy: 6.5,
    });

    expect(explanation.level).toBe('low');
    expect(explanation.quorumMet).toBe(false);
    expect(explanation.sources).toHaveLength(1);
    expect(explanation.sources[0].status).toBe('stale');
    expect(explanation.summary).toMatch(/low/i);
    expect(explanation.factors.find((f) => f.key === 'source-quorum')?.impact).toBe('negative');
  });

  test('edge (a2): missing sources (empty quorum) degrades to unknown', () => {
    const quorumStatus = yieldQuorumService.evaluateQuorum('Blend', []);

    const explanation = buildApyConfidenceExplanation({
      protocol: 'Blend',
      confidenceInputs: {
        ...fullInputs(),
        dataCompleteness: 0.1,
        modelFit: 0,
        historyCoverage: 0,
        coverageDecay: 0,
        coverageReasons: ['no_history'],
      },
      quorumStatus,
      confidence: 0.05,
      forecastApy: null,
    });

    expect(explanation.level).toBe('unknown');
    expect(explanation.quorumMet).toBe(false);
    expect(explanation.sources).toEqual([]);
    expect(explanation.summary).toMatch(/cannot be assessed/i);
  });

  test('edge (b): stale and failing sources sort last with stable fallback details', () => {
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const quorumStatus = yieldQuorumService.evaluateQuorum('Blend', [
      { provider: 'DeFiLlama', apy: 6.5, fetchedAt: now },
      { provider: 'StaleFeed', apy: 6.1, fetchedAt: stale },
      { provider: 'DeadFeed', apy: 6.9, fetchedAt: now, isFailing: true },
    ]);

    const explanation = buildApyConfidenceExplanation({
      protocol: 'Blend',
      confidenceInputs: {
        ...fullInputs(),
        coverageDecay: 0.6,
        coverageReasons: ['stale_history'],
      },
      quorumStatus,
      confidence: 0.5,
      forecastApy: 6.5,
    });

    expect(['reduced', 'low']).toContain(explanation.level);
    const byProvider = new Map(explanation.sources.map((s) => [s.provider, s]));
    expect(byProvider.get('DeadFeed')?.status).toBe('failing');
    expect(byProvider.get('StaleFeed')?.status).toBe('stale');
    expect(byProvider.get('DeFiLlama')?.status).toBe('fresh');
    for (const row of explanation.sources) {
      expect(typeof row.detail).toBe('string');
      expect(row.detail.length).toBeGreaterThan(0);
    }
  });

  test('malformed input never throws and degrades to unknown', () => {
    const explanation = buildApyConfidenceExplanation({
      protocol: null,
      confidenceInputs: { volatilityPct: Number.NaN },
      quorumStatus: { evaluatedSources: [null, 42] },
      confidence: 'bogus',
      forecastApy: undefined,
    });

    expect(explanation.protocol).toBe('unknown-protocol');
    expect(explanation.level).toBe('unknown');
    expect(explanation.confidence).toBeNull();
    expect(explanation.summary).toMatch(/cannot be assessed/i);
  });
});
