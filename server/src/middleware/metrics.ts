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
