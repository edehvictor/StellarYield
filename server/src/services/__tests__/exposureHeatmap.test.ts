import {
  EXPOSURE_HEATMAP_MAX_POSITIONS,
  EXPOSURE_HEATMAP_OTHER_KEY,
  ExposureHeatmapError,
  buildExposureHeatmap,
} from '../../../../shared/types/exposureHeatmap';
import { buildExposureBuckets } from '../../../../shared/types/exposureConcentration';

const p = (asset: string, protocol: string, valueUsd: number) => ({ asset, protocol, valueUsd });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ExposureHeatmapError ? e.code : 'NOT_TYPED';
  }
  return undefined;
}

describe('buildExposureHeatmap', () => {
  it('cross-tabs asset × protocol, largest first, with shares of the total', () => {
    const h = buildExposureHeatmap([
      p('USDC', 'Blend', 4_000),
      p('XLM', 'Soroswap', 3_000),
      p('USDC', 'Soroswap', 2_000),
      p('XLM', 'Blend', 1_000),
    ]);

    expect(h.assets.map((a) => a.label)).toEqual(['USDC', 'XLM']);
    expect(h.protocols.map((c) => c.label)).toEqual(['Blend', 'Soroswap']);
    expect(h.cells.map((row) => row.map((c) => c.valueUsd))).toEqual([
      [4_000, 2_000],
      [1_000, 3_000],
    ]);
    expect(h.cells[0][0].share).toBeCloseTo(0.4);
    expect(h.totalValueUsd).toBe(10_000);
    expect(h.maxCellShare).toBeCloseTo(0.4);
    expect(h.positionCount).toBe(4);
  });

  it('row and column totals match the existing per-dimension buckets', () => {
    const positions = [p('USDC', 'Blend', 5_162.5), p('XLM', 'Blend', 810), p('USDC', 'DeFindex', 3_090)];
    const h = buildExposureHeatmap(positions);
    const buckets = buildExposureBuckets(positions, (x) => x);

    for (const a of h.assets) expect(a.valueUsd).toBeCloseTo(buckets.byAsset[a.label]);
    for (const c of h.protocols) expect(c.valueUsd).toBeCloseTo(buckets.byProtocol[c.label]);
    h.assets.forEach((a, r) =>
      expect(h.cells[r].reduce((s, c) => s + c.valueUsd, 0)).toBeCloseTo(a.valueUsd),
    );
  });

  it('merges duplicate pairs and trims labels', () => {
    const h = buildExposureHeatmap([p(' USDC ', 'Blend', 100), p('USDC', ' Blend', 50)]);
    expect(h.assets).toHaveLength(1);
    expect(h.cells[0][0].valueUsd).toBe(150);
  });

  it('grades cells against the stricter of the asset and protocol thresholds', () => {
    const h = buildExposureHeatmap([p('USDC', 'Blend', 90), p('XLM', 'Soroswap', 10)], {
      thresholds: { asset: { warn: 0.95, critical: 0.99 }, protocol: { warn: 0.5, critical: 0.85 } },
    });
    expect(h.cellThreshold).toEqual({ warn: 0.5, critical: 0.85 });
    expect(h.cells[0][0].severity).toBe('critical');
    expect(h.assets[0].severity).toBe('ok'); // 90% is under the asset warn of 95%
    expect(h.protocols[0].severity).toBe('critical');
    expect(h.severity).toBe('critical');
  });

  it('returns an empty heatmap for no positions or only zero-value ones', () => {
    const empty = buildExposureHeatmap([]);
    expect(empty).toMatchObject({ assets: [], protocols: [], cells: [], totalValueUsd: 0, severity: 'ok' });

    const zeros = buildExposureHeatmap([p('USDC', 'Blend', 0)]);
    expect(zeros.assets).toEqual([]);
    expect(zeros.skippedCount).toBe(1);
  });

  it('collapses the long tail into "Other" without losing value', () => {
    const positions = ['A', 'B', 'C', 'D', 'E'].map((a, i) => p(a, 'Blend', 50 - i * 10));
    const h = buildExposureHeatmap(positions, { maxAssets: 3 });

    expect(h.assets.map((a) => a.key)).toEqual(['A', 'B', EXPOSURE_HEATMAP_OTHER_KEY]);
    const other = h.assets[2];
    expect(other.label).toBe('Other');
    expect(other.members).toEqual(['C', 'D', 'E']);
    expect(other.valueUsd).toBe(30 + 20 + 10);
    expect(h.cells[2][0].valueUsd).toBe(60);
  });

  it('does not confuse a real asset literally named "Other" with the collapsed bucket', () => {
    const h = buildExposureHeatmap(
      [p('Other', 'Blend', 100), p('B', 'Blend', 50), p('C', 'Blend', 10), p('D', 'Blend', 5)],
      { maxAssets: 3 },
    );
    expect(h.assets.map((a) => a.key)).toEqual(['Other', 'B', EXPOSURE_HEATMAP_OTHER_KEY]);
  });

  it('is independent of input order', () => {
    const positions = [p('USDC', 'Blend', 10), p('XLM', 'Blend', 10), p('AQUA', 'Soroswap', 10)];
    expect(buildExposureHeatmap([...positions].reverse())).toEqual(buildExposureHeatmap(positions));
  });

  it.each([
    ['missing asset', { protocol: 'Blend', valueUsd: 1 }],
    ['blank protocol', { asset: 'USDC', protocol: '  ', valueUsd: 1 }],
    ['negative value', { asset: 'USDC', protocol: 'Blend', valueUsd: -1 }],
    ['NaN value', { asset: 'USDC', protocol: 'Blend', valueUsd: Number.NaN }],
    ['string value', { asset: 'USDC', protocol: 'Blend', valueUsd: '5' }],
    ['non-object', 'USDC'],
  ])('rejects %s with INVALID_POSITION and its index', (_label, bad) => {
    let error: unknown;
    try {
      buildExposureHeatmap([p('XLM', 'Blend', 1), bad]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ExposureHeatmapError);
    expect((error as ExposureHeatmapError).code).toBe('INVALID_POSITION');
    expect((error as ExposureHeatmapError).index).toBe(1);
  });

  it('rejects oversized input with TOO_MANY_POSITIONS', () => {
    const many = Array.from({ length: EXPOSURE_HEATMAP_MAX_POSITIONS + 1 }, () => p('USDC', 'Blend', 1));
    expect(codeOf(() => buildExposureHeatmap(many))).toBe('TOO_MANY_POSITIONS');
  });

  it.each([0, 51, 2.5])('rejects maxAssets=%p with INVALID_OPTIONS', (maxAssets) => {
    expect(codeOf(() => buildExposureHeatmap([], { maxAssets }))).toBe('INVALID_OPTIONS');
  });
});
