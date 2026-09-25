import { HealthWeightedNormalizerService, ProtocolHealth } from '../healthWeightedNormalizerService';

const svc = new HealthWeightedNormalizerService();

const health = (id: string, score: number, hardBlocked = false, frozen = false): [string, ProtocolHealth] =>
  [id, { protocolId: id, healthScore: score, hardBlocked, frozen }];

describe('HealthWeightedNormalizerService', () => {
  it('healthy protocols retain full weight', () => {
    const result = svc.normalize(
      [{ protocolId: 'A', rawWeight: 50 }, { protocolId: 'B', rawWeight: 50 }],
      Object.fromEntries([health('A', 1), health('B', 1)])
    );
    expect(result[0].normalizedPct).toBe(0.5);
    expect(result[1].normalizedPct).toBe(0.5);
  });

  it('degraded protocol loses allocation weight', () => {
    const result = svc.normalize(
      [{ protocolId: 'A', rawWeight: 50 }, { protocolId: 'B', rawWeight: 50 }],
      Object.fromEntries([health('A', 1), health('B', 0.2)])
    );
    expect(result[0].normalizedPct).toBeGreaterThan(result[1].normalizedPct);
  });

  it('hard-blocked protocol gets 0 allocation', () => {
    const result = svc.normalize(
      [{ protocolId: 'A', rawWeight: 50 }, { protocolId: 'B', rawWeight: 50 }],
      Object.fromEntries([health('A', 1), health('B', 0.9, true)])
    );
    expect(result.find(r => r.protocolId === 'B')!.normalizedPct).toBe(0);
  });

  it('frozen protocol gets 0 allocation', () => {
    const result = svc.normalize(
      [{ protocolId: 'A', rawWeight: 50 }, { protocolId: 'B', rawWeight: 50 }],
      Object.fromEntries([health('A', 1), health('B', 1, false, true)])
    );
    expect(result.find(r => r.protocolId === 'B')!.normalizedPct).toBe(0);
  });

  it('mixed-health allocation sums to 1', () => {
    const result = svc.normalize(
      [{ protocolId: 'A', rawWeight: 40 }, { protocolId: 'B', rawWeight: 30 }, { protocolId: 'C', rawWeight: 30 }],
      Object.fromEntries([health('A', 1), health('B', 0.5), health('C', 0.8)])
    );
    const sum = result.reduce((s, r) => s + r.normalizedPct, 0);
    expect(sum).toBeCloseTo(1, 3);
  });

  it('tunable weightingStrength=0 leaves weights unchanged', () => {
    const result = svc.normalize(
      [{ protocolId: 'A', rawWeight: 50 }, { protocolId: 'B', rawWeight: 50 }],
      Object.fromEntries([health('A', 1), health('B', 0)]),
      { weightingStrength: 0 }
    );
    expect(result[0].normalizedPct).toBeCloseTo(0.5, 2);
    expect(result[1].normalizedPct).toBeCloseTo(0.5, 2);
  });
});
