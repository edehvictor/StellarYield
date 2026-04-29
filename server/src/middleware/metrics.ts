import { Request, Response, NextFunction } from 'express';

// In-memory store for simple metrics
interface Metrics {
  requestLatencies: number[];
  cacheHits: number;
  cacheMisses: number;
}

export const metrics: Metrics = {
  requestLatencies: [],
  cacheHits: 0,
  cacheMisses: 0,
};

function isMetricsAuthorized(req: Request): boolean {
  const token = process.env.METRICS_TOKEN;
  const nodeEnv = process.env.NODE_ENV;

  // Safe-by-default: in production, require an explicit token.
  if (nodeEnv === 'production' && !token) return false;
  if (!token) return true; // dev/test default

  const headerToken =
    (req.get('x-metrics-token') ?? '').trim() ||
    (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

  return headerToken.length > 0 && headerToken === token;
}

// Middleware to track latency
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    metrics.requestLatencies.push(duration);
    
    // Keep only the last 1000 latencies to avoid memory leaks
    if (metrics.requestLatencies.length > 1000) {
      metrics.requestLatencies.shift();
    }
    
    // Attempt rudimentary cache heuristic if using internal caching header
    const cacheStatus = res.getHeader('X-Cache-Status');
    if (cacheStatus === 'HIT') {
      metrics.cacheHits++;
    } else if (cacheStatus === 'MISS') {
      metrics.cacheMisses++;
    }
  });
  
  next();
};

export const getMetrics = async (req: Request, res: Response) => {
  if (!isMetricsAuthorized(req)) {
    // Avoid advertising the endpoint when locked down.
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const latencies = metrics.requestLatencies;
  const avgLatency = latencies.length > 0 
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length 
    : 0;

  res.json({
    avgLatencyMs: Math.round(avgLatency),
    requestCount: latencies.length,
    cacheHits: metrics.cacheHits,
    cacheMisses: metrics.cacheMisses,
    providerStatus: 'Healthy', // or mock logic based on actual checks
    uptime: process.uptime()
  });
};
