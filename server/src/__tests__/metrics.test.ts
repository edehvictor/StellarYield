import request from 'supertest';
import { createApp } from '../app';

describe('Metrics Endpoint', () => {
  const app = createApp();
  app.get('/__metrics-test-ping', (_req, res) => {
    res.json({ ok: true });
  });

  it('should return metrics with correct shape', async () => {
    // Generate some traffic to populate metrics
    await request(app).get('/__metrics-test-ping');
    
    const response = await request(app).get('/api/metrics');
    
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('avgLatencyMs');
    expect(response.body).toHaveProperty('requestCount');
    expect(response.body).toHaveProperty('cacheHits');
    expect(response.body).toHaveProperty('cacheMisses');
    expect(response.body).toHaveProperty('providerStatus');
    expect(response.body).toHaveProperty('uptime');
    
    expect(typeof response.body.avgLatencyMs).toBe('number');
    expect(typeof response.body.requestCount).toBe('number');
    expect(typeof response.body.cacheHits).toBe('number');
    expect(typeof response.body.cacheMisses).toBe('number');
    
    // requestCount should be > 0 since we made a request
    expect(response.body.requestCount).toBeGreaterThan(0);
  });

  it('should hide metrics in production without token', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevToken = process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'production';
    delete process.env.METRICS_TOKEN;

    const response = await request(app).get('/api/metrics');
    expect(response.status).toBe(404);

    process.env.NODE_ENV = prevEnv;
    if (prevToken) process.env.METRICS_TOKEN = prevToken;
  });

  it('should require token when configured', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevToken = process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'production';
    process.env.METRICS_TOKEN = 'test-token';

    const denied = await request(app).get('/api/metrics');
    expect(denied.status).toBe(404);

    const allowed = await request(app)
      .get('/api/metrics')
      .set('x-metrics-token', 'test-token');
    expect(allowed.status).toBe(200);

    process.env.NODE_ENV = prevEnv;
    if (prevToken) process.env.METRICS_TOKEN = prevToken;
    else delete process.env.METRICS_TOKEN;
  });
});
