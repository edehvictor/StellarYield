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
});
