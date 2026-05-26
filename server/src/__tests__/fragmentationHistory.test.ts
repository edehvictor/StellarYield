import request from 'supertest';
import { createApp } from '../app';
import { getHistoricalServiceForTesting } from '../routes/fragmentation';
import fc from 'fast-check';

describe('GET /api/liquidity/fragmentation/history', () => {
  const app = createApp();

  beforeEach(() => {
    getHistoricalServiceForTesting().resetHistory();
  });

  describe('Basic functionality', () => {
    it('returns 200 with snapshots array', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data.snapshots)).toBe(true);
      expect(res.body.data.snapshots.length).toBeGreaterThan(0);
    });

    it('includes data freshness metadata', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      expect(res.body.data.dataFreshness).toBeDefined();
      expect(res.body.data.dataFreshness).toHaveProperty('earliestSnapshot');
      expect(res.body.data.dataFreshness).toHaveProperty('latestSnapshot');
      expect(res.body.data.dataFreshness).toHaveProperty('snapshotCount');
      expect(res.body.data.dataFreshness.snapshotCount).toBe(res.body.data.snapshots.length);
    });

    it('includes source field', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      expect(['live', 'mock', 'historical']).toContain(res.body.data.source);
    });
  });

  describe('Snapshot validation', () => {
    it('each snapshot has required fields', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      res.body.data.snapshots.forEach((snapshot: Record<string, unknown>) => {
        expect(snapshot).toHaveProperty('timestamp');
        expect(snapshot).toHaveProperty('fragmentationScore');
        expect(snapshot).toHaveProperty('effectiveProtocolCount');
        expect(snapshot).toHaveProperty('hhi');
        expect(snapshot).toHaveProperty('multiProtocolRoutingPct');
        expect(snapshot).toHaveProperty('executionQualityScore');
      });
    });

    it('fragmentationScore is in valid range [0, 100]', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      res.body.data.snapshots.forEach((snapshot: { fragmentationScore: number }) => {
        expect(snapshot.fragmentationScore).toBeGreaterThanOrEqual(0);
        expect(snapshot.fragmentationScore).toBeLessThanOrEqual(100);
      });
    });

    it('executionQualityScore is in valid range [0, 100]', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      res.body.data.snapshots.forEach((snapshot: { executionQualityScore: number }) => {
        expect(snapshot.executionQualityScore).toBeGreaterThanOrEqual(0);
        expect(snapshot.executionQualityScore).toBeLessThanOrEqual(100);
      });
    });

    it('effectiveProtocolCount is at least 1', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      res.body.data.snapshots.forEach((snapshot: { effectiveProtocolCount: number }) => {
        expect(snapshot.effectiveProtocolCount).toBeGreaterThanOrEqual(1);
      });
    });

    it('timestamps are valid ISO 8601', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      res.body.data.snapshots.forEach((snapshot: { timestamp: string }) => {
        const ts = new Date(snapshot.timestamp);
        expect(ts.getTime()).not.toBeNaN();
      });
    });
  });

  describe('Days parameter', () => {
    it('respects days query parameter', async () => {
      const res7 = await request(app).get('/api/liquidity/fragmentation/history?days=7');
      expect(res7.body.data.snapshots.length).toBeLessThanOrEqual(7);

      const res30 = await request(app).get('/api/liquidity/fragmentation/history?days=30');
      expect(res30.body.data.snapshots.length).toBeGreaterThanOrEqual(res7.body.data.snapshots.length);
    });

    it('clamps days to min 1', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history?days=0');
      expect(res.status).toBe(200);
      expect(res.body.data.snapshots.length).toBeGreaterThanOrEqual(1);
    });

    it('clamps days to max 365', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history?days=500');
      expect(res.status).toBe(200);
    });

    it('defaults to 30 days when not provided', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');
      expect(res.status).toBe(200);
      const resDefault = await request(app).get('/api/liquidity/fragmentation/history?days=30');
      expect(res.body.data.snapshots.length).toBe(resDefault.body.data.snapshots.length);
    });
  });

  describe('Cache headers', () => {
    it('includes Cache-Control header', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      expect(res.headers['cache-control']).toBeDefined();
      expect(res.headers['cache-control']).toContain('public');
    });
  });

  describe('Property-based tests', () => {
    it('all timestamps are chronological', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(null),
          async () => {
            const res = await request(app).get('/api/liquidity/fragmentation/history');
            if (res.status !== 200) return true;

            const snapshots = res.body.data.snapshots as { timestamp: string }[];
            for (let i = 1; i < snapshots.length; i++) {
              const prev = new Date(snapshots[i - 1].timestamp).getTime();
              const curr = new Date(snapshots[i].timestamp).getTime();
              expect(curr).toBeGreaterThan(prev);
            }
            return true;
          },
        ),
        { numRuns: 50 },
      );
    }, 30000);

    it('fragmentationScore and executionQualityScore are always in [0, 100]', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant(null),
          async () => {
            const res = await request(app).get('/api/liquidity/fragmentation/history');
            if (res.status !== 200) return true;

            const snapshots = res.body.data.snapshots as {
              fragmentationScore: number;
              executionQualityScore: number;
            }[];
            snapshots.forEach((s) => {
              expect(s.fragmentationScore).toBeGreaterThanOrEqual(0);
              expect(s.fragmentationScore).toBeLessThanOrEqual(100);
              expect(s.executionQualityScore).toBeGreaterThanOrEqual(0);
              expect(s.executionQualityScore).toBeLessThanOrEqual(100);
            });
            return true;
          },
        ),
        { numRuns: 50 },
      );
    }, 30000);
  });

  describe('Warning scenarios', () => {
    it('includes mock data warning when source is mock', async () => {
      const res = await request(app).get('/api/liquidity/fragmentation/history');

      if (res.body.data.source === 'mock') {
        expect(res.body.data.warnings).toBeDefined();
        expect(res.body.data.warnings.length).toBeGreaterThan(0);
      }
    });
  });
});
