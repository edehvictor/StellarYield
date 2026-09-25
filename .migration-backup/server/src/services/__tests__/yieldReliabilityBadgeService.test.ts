import { YieldReliabilityBadgeService } from '../yieldReliabilityBadgeService';

const svc = new YieldReliabilityBadgeService();

describe('YieldReliabilityBadgeService', () => {
  it('assigns high badge for strong signals', () => {
    const r = svc.assignBadge({ freshness: 1, providerAgreement: 1, trustSignal: 1 });
    expect(r.badge).toBe('high');
  });

  it('assigns moderate badge for mixed signals', () => {
    const r = svc.assignBadge({ freshness: 0.6, providerAgreement: 0.5, trustSignal: 0.5 });
    expect(r.badge).toBe('moderate');
  });

  it('assigns low badge for weak signals', () => {
    const r = svc.assignBadge({ freshness: 0.1, providerAgreement: 0.2, trustSignal: 0.1 });
    expect(r.badge).toBe('low');
  });

  it('low badge includes cautionary reason text', () => {
    const r = svc.assignBadge({ freshness: 0, providerAgreement: 0, trustSignal: 0 });
    expect(r.reason.toLowerCase()).toContain('caution');
  });

  it('batch assigns badges for multiple sources', () => {
    const results = svc.assignBadges({
      src1: { freshness: 1, providerAgreement: 1, trustSignal: 1 },
      src2: { freshness: 0, providerAgreement: 0, trustSignal: 0 },
    });
    expect(results.src1.badge).toBe('high');
    expect(results.src2.badge).toBe('low');
  });

  it('score is weighted sum of inputs', () => {
    const r = svc.assignBadge({ freshness: 1, providerAgreement: 0, trustSignal: 0 });
    expect(r.score).toBeCloseTo(0.4, 2); // freshness weight = 0.4
  });

  describe('Protocol Trust Signals Registry', () => {
    it('calculates fallback trust score for unknown protocols', () => {
      const r = svc.assignBadge({ freshness: 1, providerAgreement: 1, trustSignal: 0, protocolId: 'unknown_protocol' });
      // Fallback is 0.5 trust. Weight is 0.25 -> 0.125. Freshness/Agreement are 1.0 -> 0.4 + 0.35 = 0.75. Sum = 0.875
      expect(r.score).toBeCloseTo(0.875, 3);
      expect(r.badge).toBe('high');
    });

    it('calculates high trust score for highly secure protocol (Blend)', () => {
      const r = svc.assignBadge({ freshness: 1, providerAgreement: 1, trustSignal: 0, protocolId: 'blend' });
      // Blend trust is 0.95. 0.95 * 0.25 = 0.2375. Sum = 0.4 + 0.35 + 0.2375 = 0.9875 (rounded to 0.988)
      expect(r.score).toBeCloseTo(0.988, 3);
      expect(r.badge).toBe('high');
    });

    it('calculates lower trust score for protocol with incident history (Soroswap)', () => {
      const r = svc.assignBadge({ freshness: 0.5, providerAgreement: 0.5, trustSignal: 0.5, protocolId: 'soroswap' });
      // Soroswap has 1 resolved incident, age 12m, 1 audit, active, $4.5M TVL.
      // Age score = 0.8 (12m). Audit = 0.7 (1). TVL = 0.7 ($4.5M). Incidents = 0.5 (resolved). Ops = 1.0 (active).
      // Sum = 0.8 * 0.25 + 0.7 * 0.25 + 0.7 * 0.15 + 0.5 * 0.20 + 1.0 * 0.15 = 0.2 + 0.175 + 0.105 + 0.1 + 0.15 = 0.73.
      // Badge score: 0.5 * 0.4 + 0.5 * 0.35 + 0.73 * 0.25 = 0.2 + 0.175 + 0.1825 = 0.5575.
      expect(r.score).toBeCloseTo(0.558, 3);
      expect(r.badge).toBe('moderate');
    });
  });
});

