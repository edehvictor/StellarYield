import {
  DEFAULT_CONCENTRATION_THRESHOLDS,
  analyzeConcentration,
  buildExposureBuckets,
  resolveConcentrationThresholds,
} from '../../../../shared/types/exposureConcentration';
import { getConcentrationThresholds } from '../../config/concentrationThresholds';
import { analyzePositionConcentration } from '../portfolioReconcileService';
import { PortfolioService, VaultPosition } from '../portfolioService';

describe('analyzeConcentration', () => {
  it('grades a dominant asset as a warning and a dominant protocol as critical', () => {
    const result = analyzeConcentration({
      byAsset: { USDC: 6_000, XLM: 4_000 },
      byProtocol: { Blend: 10_000 },
    });

    expect(result.totalValueUsd).toBe(10_000);
    expect(result.topAssetShare).toBeCloseTo(0.6);
    expect(result.topProtocolShare).toBe(1);
    expect(result.severity).toBe('critical');
    expect(result.messages).toEqual([
      'Critical concentration in Blend protocol (100%)',
      'High concentration in USDC (60%)',
    ]);
  });

  it('reports no warnings for a balanced portfolio', () => {
    const result = analyzeConcentration({
      byAsset: { USDC: 500, XLM: 500 },
      byProtocol: { Blend: 500, Soroswap: 500 },
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.severity).toBe('ok');
  });

  it('treats an exactly-at-threshold share as safe', () => {
    const result = analyzeConcentration(
      { byAsset: { USDC: 500, XLM: 500 }, byProtocol: { Blend: 500, Soroswap: 500 } },
      { asset: { warn: 0.5 } },
    );

    expect(result.warnings).toHaveLength(0);
  });

  it('honors custom thresholds per dimension', () => {
    const input = { byAsset: { USDC: 600, XLM: 400 }, byProtocol: { Blend: 600, Soroswap: 400 } };

    // A 60% share warns as an asset (warn 0.55) but not as a protocol (warn 0.65).
    const perDimension = analyzeConcentration(input, {
      asset: { warn: 0.55 },
      protocol: { warn: 0.65 },
    });
    expect(perDimension.warnings.map((w) => w.dimension)).toEqual(['asset']);

    const loose = analyzeConcentration(input, {
      asset: { warn: 0.9 },
      protocol: { warn: 0.9 },
    });
    expect(loose.warnings).toHaveLength(0);
  });

  it('sorts warnings by severity then size', () => {
    const result = analyzeConcentration(
      { byAsset: { USDC: 900, XLM: 100 }, byProtocol: { Blend: 700, Soroswap: 300 } },
      { asset: { warn: 0.5, critical: 0.85 }, protocol: { warn: 0.5, critical: 0.85 } },
    );

    expect(result.warnings.map((w) => `${w.name}:${w.severity}`)).toEqual([
      'USDC:critical',
      'Blend:warning',
    ]);
  });

  it('handles an empty portfolio without dividing by zero', () => {
    const result = analyzeConcentration({ byAsset: {}, byProtocol: {} });

    expect(result.totalValueUsd).toBe(0);
    expect(result.topAssetShare).toBe(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.severity).toBe('ok');
  });

  it('ignores zero and negative buckets', () => {
    const result = analyzeConcentration({
      byAsset: { USDC: 1_000, DUST: 0, BROKEN: -50 },
      byProtocol: { Blend: 1_000 },
    });

    expect(result.entries.map((e) => e.name)).toEqual(['USDC', 'Blend']);
    expect(result.totalValueUsd).toBe(1_000);
  });

  it('uses an explicit total when the buckets do not sum to it', () => {
    const result = analyzeConcentration({
      byAsset: { USDC: 600 },
      byProtocol: { Blend: 600 },
      totalValueUsd: 1_200,
    });

    expect(result.topAssetShare).toBeCloseTo(0.5);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('resolveConcentrationThresholds', () => {
  it('falls back to defaults when overrides are absent', () => {
    expect(resolveConcentrationThresholds()).toEqual(DEFAULT_CONCENTRATION_THRESHOLDS);
  });

  it('merges partial overrides onto the defaults', () => {
    const resolved = resolveConcentrationThresholds({ asset: { warn: 0.3 } });

    expect(resolved.asset).toEqual({ warn: 0.3, critical: 0.85 });
    expect(resolved.protocol).toEqual(DEFAULT_CONCENTRATION_THRESHOLDS.protocol);
  });

  it('rejects out-of-range and non-finite values', () => {
    const resolved = resolveConcentrationThresholds({
      asset: { warn: 0, critical: 1.5 },
      protocol: { warn: Number.NaN },
    });

    expect(resolved).toEqual(DEFAULT_CONCENTRATION_THRESHOLDS);
  });

  it('never lets critical sit below warn', () => {
    const resolved = resolveConcentrationThresholds({ asset: { warn: 0.9, critical: 0.6 } });

    expect(resolved.asset).toEqual({ warn: 0.9, critical: 0.9 });
  });
});

describe('getConcentrationThresholds', () => {
  it('reads shares from the environment', () => {
    const resolved = getConcentrationThresholds({
      CONCENTRATION_ASSET_WARN_SHARE: '0.35',
      CONCENTRATION_PROTOCOL_CRITICAL_SHARE: '0.95',
    } as NodeJS.ProcessEnv);

    expect(resolved.asset.warn).toBe(0.35);
    expect(resolved.protocol.critical).toBe(0.95);
    expect(resolved.protocol.warn).toBe(DEFAULT_CONCENTRATION_THRESHOLDS.protocol.warn);
  });

  it('ignores unparseable values', () => {
    const resolved = getConcentrationThresholds({
      CONCENTRATION_ASSET_WARN_SHARE: 'not-a-number',
    } as NodeJS.ProcessEnv);

    expect(resolved).toEqual(DEFAULT_CONCENTRATION_THRESHOLDS);
  });
});

describe('buildExposureBuckets', () => {
  it('aggregates positions by asset and protocol', () => {
    const buckets = buildExposureBuckets(
      [
        { asset: 'USDC', protocol: 'Blend', value: 1_000 },
        { asset: 'USDC', protocol: 'Soroswap', value: 500 },
        { asset: 'XLM', protocol: 'Blend', value: 250 },
      ],
      (p) => ({ asset: p.asset, protocol: p.protocol, valueUsd: p.value }),
    );

    expect(buckets.byAsset).toEqual({ USDC: 1_500, XLM: 250 });
    expect(buckets.byProtocol).toEqual({ Blend: 1_250, Soroswap: 500 });
    expect(buckets.totalValueUsd).toBe(1_750);
  });
});

describe('PortfolioService concentration', () => {
  const concentrated: VaultPosition[] = [
    { protocol: 'Blend', asset: 'USDC', depositedUsd: 1_000, currentValueUsd: 8_000 },
    { protocol: 'Soroswap', asset: 'XLM', depositedUsd: 1_000, currentValueUsd: 2_000 },
  ];

  it('exposes structured concentration alongside the message list', async () => {
    const result = await PortfolioService.getExposureMap(concentrated);

    expect(result.concentrationWarnings).toEqual(result.concentration.messages);
    expect(result.concentration.topAssetShare).toBeCloseTo(0.8);
    expect(result.concentration.severity).toBe('warning');
    expect(result.concentration.warnings.map((w) => w.dimension).sort()).toEqual([
      'asset',
      'protocol',
    ]);
  });

  it('applies caller-supplied thresholds', async () => {
    const relaxed = await PortfolioService.getExposureMap(concentrated, {
      asset: { warn: 0.9 },
      protocol: { warn: 0.9 },
    });
    expect(relaxed.concentrationWarnings).toHaveLength(0);

    const strict = await PortfolioService.getExposureMap(concentrated, {
      asset: { warn: 0.1 },
      protocol: { warn: 0.1 },
    });
    expect(strict.concentrationWarnings.length).toBe(4);
  });
});

describe('analyzePositionConcentration', () => {
  it('grades reconciled positions by asset and protocol', () => {
    const analysis = analyzePositionConcentration([
      { assetId: 'USDC', amount: 900, vaultId: 'v1', protocol: 'Blend' },
      { assetId: 'XLM', amount: 100, vaultId: 'v2', protocol: 'Soroswap' },
    ]);

    expect(analysis.topAssetShare).toBeCloseTo(0.9);
    expect(analysis.messages).toContain('Critical concentration in USDC (90%)');
  });

  it('returns a clean analysis for no positions', () => {
    const analysis = analyzePositionConcentration([]);

    expect(analysis.severity).toBe('ok');
    expect(analysis.warnings).toHaveLength(0);
  });
});

describe('sparse and concentrated portfolios (#869)', () => {
  it('normalizes a single-asset portfolio to 100% share with warnings', () => {
    const result = analyzeConcentration({
      byAsset: { USDC: 10_000 },
      byProtocol: { Blend: 10_000 },
    });

    expect(result.totalValueUsd).toBe(10_000);
    expect(result.topAssetShare).toBeCloseTo(1);
    expect(result.topProtocolShare).toBeCloseTo(1);
    expect(result.entries).toHaveLength(2);
    expect(result.messages).toEqual(
      expect.arrayContaining([
        'Critical concentration in Blend protocol (100%)',
        'Critical concentration in USDC (100%)',
      ]),
    );
  });

  it('keeps near-single-asset residual shares stable without false warnings on dust', () => {
    const result = analyzeConcentration({
      byAsset: { USDC: 9_999.99, XLM: 0.01 },
      byProtocol: { Blend: 10_000 },
    });

    expect(result.totalValueUsd).toBeCloseTo(10_000);
    expect(result.topAssetShare).toBeCloseTo(0.999999);
    const xlmEntry = result.entries.find((e) => e.name === 'XLM');
    expect(xlmEntry?.share).toBeCloseTo(0.000001, 6);
    expect(result.warnings.map((w) => w.name)).toEqual(['Blend', 'USDC']);
    expect(result.warnings.some((w) => w.name === 'XLM')).toBe(false);
  });

  it('handles sparse category coverage when only one dimension is populated', () => {
    const assetOnly = analyzeConcentration({
      byAsset: { USDC: 5_000, XLM: 5_000 },
      byProtocol: {},
    });
    expect(assetOnly.topAssetShare).toBe(0.5);
    expect(assetOnly.topProtocolShare).toBe(0);
    expect(assetOnly.warnings).toHaveLength(0);

    const protocolOnly = analyzeConcentration({
      byAsset: {},
      byProtocol: { Blend: 3_000 },
      totalValueUsd: 3_000,
    });
    expect(protocolOnly.topProtocolShare).toBe(1);
    expect(protocolOnly.messages).toContain('Critical concentration in Blend protocol (100%)');
  });

  it('does not warn at exactly the warn threshold (50/50 split)', () => {
    const result = analyzeConcentration({
      byAsset: { USDC: 500, XLM: 500 },
      byProtocol: { Blend: 500, Soroswap: 500 },
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.entries.every((e) => e.share === 0.5)).toBe(true);
  });
});

describe('PortfolioService sparse and concentrated portfolios (#869)', () => {
  it('grades a single-position portfolio as fully concentrated', async () => {
    const result = await PortfolioService.getExposureMap([
      { protocol: 'Blend', asset: 'USDC', depositedUsd: 1_000, currentValueUsd: 10_000 },
    ]);

    expect(result.totalValueUsd).toBe(10_000);
    expect(result.concentration.topAssetShare).toBe(1);
    expect(result.concentration.severity).toBe('critical');
  });

  it('preserves tiny residual allocations in normalization', async () => {
    const result = await PortfolioService.getExposureMap([
      { protocol: 'Blend', asset: 'USDC', depositedUsd: 9_999, currentValueUsd: 9_999.99 },
      { protocol: 'Blend', asset: 'XLM', depositedUsd: 0.01, currentValueUsd: 0.01 },
    ]);

    expect(Object.keys(result.byAsset)).toEqual(['USDC', 'XLM']);
    expect(result.byAsset.XLM).toBe(0.01);
    expect(result.concentration.topAssetShare).toBeGreaterThan(0.999);
  });
});
