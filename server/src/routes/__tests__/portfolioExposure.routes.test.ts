import request from 'supertest';
import express, { Express } from 'express';
import { createPortfolioExposureRouter } from '../portfolioExposure';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/portfolio/exposure', createPortfolioExposureRouter());
  return app;
}

const URL = '/api/portfolio/exposure/heatmap';

describe('POST /api/portfolio/exposure/heatmap', () => {
  const envBackup = { ...process.env };
  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('returns the asset × protocol matrix', async () => {
    const res = await request(buildApp())
      .post(URL)
      .send({
        positions: [
          { asset: 'USDC', protocol: 'Blend', valueUsd: 600 },
          { asset: 'XLM', protocol: 'Soroswap', valueUsd: 400 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.assets.map((a: { label: string }) => a.label)).toEqual(['USDC', 'XLM']);
    expect(res.body.cells[0][0]).toEqual({ valueUsd: 600, share: 0.6, severity: 'warning' });
    expect(res.body.cells[0][1].valueUsd).toBe(0);
  });

  it('accepts the server VaultPosition shape (currentValueUsd)', async () => {
    const res = await request(buildApp())
      .post(URL)
      .send({ positions: [{ asset: 'USDC', protocol: 'Blend', depositedUsd: 90, currentValueUsd: 100 }] });
    expect(res.status).toBe(200);
    expect(res.body.totalValueUsd).toBe(100);
  });

  it('returns an empty matrix (200) for an empty portfolio', async () => {
    const res = await request(buildApp()).post(URL).send({ positions: [] });
    expect(res.status).toBe(200);
    expect(res.body.assets).toEqual([]);
    expect(res.body.cells).toEqual([]);
  });

  it('applies deployment threshold overrides from the environment', async () => {
    process.env.CONCENTRATION_ASSET_WARN_SHARE = '0.7';
    process.env.CONCENTRATION_PROTOCOL_WARN_SHARE = '0.7';
    const res = await request(buildApp())
      .post(URL)
      .send({ positions: [{ asset: 'USDC', protocol: 'Blend', valueUsd: 60 }, { asset: 'XLM', protocol: 'Soroswap', valueUsd: 40 }] });
    expect(res.body.cells[0][0].severity).toBe('ok');
  });

  it('400 MALFORMED_INPUT when positions is not an array', async () => {
    const res = await request(buildApp()).post(URL).send({ positions: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MALFORMED_INPUT');
  });

  it('400 INVALID_POSITION with the offending index', async () => {
    const res = await request(buildApp())
      .post(URL)
      .send({ positions: [{ asset: 'USDC', protocol: 'Blend', valueUsd: 1 }, { asset: 'XLM', protocol: 'Blend', valueUsd: -5 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_POSITION');
    expect(res.body.details).toEqual({ index: 1 });
  });

  it('400 INVALID_OPTIONS for a non-numeric or out-of-range axis limit', async () => {
    const app = buildApp();
    for (const maxAssets of ['5', 0, 999]) {
      const res = await request(app).post(URL).send({ positions: [], maxAssets });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_OPTIONS');
    }
  });
});
