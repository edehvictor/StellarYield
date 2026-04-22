import request from 'supertest';
import { createApp } from '../app';

describe('Metrics Endpoint', () => {
  const app = createApp();

  it('should return metrics with correct shape', async () => {
    // Generate some traffic to populate metrics
    await request(app).get('/api/yields');
    
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
});
