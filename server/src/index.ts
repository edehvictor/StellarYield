import { createApp } from "./app";
import { initializeZapSupportedAssetsCache } from "./config/zapAssetsConfig";
import { startIndexer } from "./indexer/indexer";
import { startHistoricalYieldAggregationJob } from "./jobs/historicalYieldAggregation";
import { startSharePriceSnapshotJob } from "./jobs/sharePriceSnapshot";
import { startHealthMonitor } from "./monitoring/healthMonitor";
import { assertValidServerEnv } from "./config/env";
import express, { Request, Response } from 'express';
import cors from 'cors';
import { metricsMiddleware, getMetrics } from './middleware/metrics';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { DigestBuilder, DigestDeliveryService } from './services/digest';
import { createDigestGenerationWorker, createDigestThresholdCheckWorker } from './jobs/digestSchedulerJob';
import { QUEUE_NAMES } from './queues/types';

assertValidServerEnv();
initializeZapSupportedAssetsCache();

const app = createApp();
app.use(cors());
app.use(express.json());
app.use(metricsMiddleware);

const PORT = process.env.PORT || 3001;

// Endpoints
app.get('/api/metrics', getMetrics);

// Mock Data for Vaults
const now = new Date();
const mockYields = [
  { protocol: 'Blend', asset: 'USDC', apy: 6.5, tvl: 12000000, risk: 'Low', fetchedAt: now.toISOString() },
  { protocol: 'Soroswap', asset: 'XLM-USDC', apy: 12.2, tvl: 4500000, risk: 'Medium', fetchedAt: new Date(now.getTime() - 6 * 60000).toISOString() }, // 6 mins old (stale)
  { protocol: 'DeFindex', asset: 'Yield Index', apy: 8.9, tvl: 8000000, risk: 'Medium', fetchedAt: now.toISOString() },
  { protocol: 'Blend', asset: 'XLM', apy: 4.2, tvl: 25000000, risk: 'Low', fetchedAt: now.toISOString() },
  { protocol: 'Soroswap', asset: 'AQUA-USDC', apy: 18.5, tvl: 1200000, risk: 'High', fetchedAt: now.toISOString() }
];

app.get('/api/yields', (req: Request, res: Response) => {
  res.json(mockYields);
});

startIndexer().catch(console.error);
startHistoricalYieldAggregationJob();
startSharePriceSnapshotJob();
startHealthMonitor().catch(console.error);

// ─── Digest workers ───────────────────────────────────────────────────────────
const digestRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
const digestBuilder = new DigestBuilder(digestRedis);
const digestDeliveryService = new DigestDeliveryService(
  async (walletAddress) => {
    console.log(`[DigestDeliveryService] emailLookup stub called for ${walletAddress}`);
    return null;
  },
  async (_to, _subject, _html) => {
    console.log(`[DigestDeliveryService] sendEmail stub called: to=${_to}, subject=${_subject}`);
  },
);
const digestGenerationQueue = new Queue(QUEUE_NAMES.DIGEST_GENERATION, {
  connection: digestRedis,
});
createDigestGenerationWorker(digestRedis, digestBuilder, digestDeliveryService);
createDigestThresholdCheckWorker(digestRedis, digestBuilder, digestGenerationQueue);
console.log('[digest] Workers registered: digest-generation, digest-threshold-check');

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
