import http from 'http';
import type { Queue } from 'bullmq';
import { getQueueHealth } from '../queues';
import { logger } from '../utils/logger';
import { keeperAuditLog } from '../audit/KeeperAuditLog';

/**
 * Starts a minimal HTTP server exposing keeper queue health.
 *
 * GET /health        — liveness probe: always 200 while the process is alive.
 * GET /health/queues — queue depth and failure counts; 200 on success, 503 on error.
 *                      Body `overallStatus` field distinguishes "healthy" from "warning".
 * GET /audit/export?stream=&from=&to= — bounded export of a keeper decision audit
 *                      stream (see issue #912); 400 if `stream` is missing, 500 on error.
 *
 * Returns the http.Server instance so callers can close it during graceful shutdown.
 * Port defaults to KEEPER_HEALTH_PORT env var or 3002.
 */
export function startKeeperHealthServer(
  queues: Queue[],
  port = Number(process.env.KEEPER_HEALTH_PORT ?? 3002),
  auditLog: Pick<typeof keeperAuditLog, 'exportStream'> = keeperAuditLog,
): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    if (req.method === 'GET' && url.startsWith('/audit/export')) {
      const requestUrl = new URL(url, 'http://localhost');
      const stream = requestUrl.searchParams.get('stream');
      const from = requestUrl.searchParams.get('from') ?? undefined;
      const to = requestUrl.searchParams.get('to') ?? undefined;

      if (!stream) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required query parameter "stream"' }));
        return;
      }

      try {
        const records = auditLog.exportStream(stream, from, to);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stream, count: records.length, records }));
      } catch (err) {
        logger.error({ err, stream }, 'Keeper audit export failed');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Audit export failed' }));
      }
      return;
    }

    if (req.method === 'GET' && url === '/health/queues') {
      getQueueHealth(queues)
        .then((summary) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(summary));
        })
        .catch((err: unknown) => {
          logger.error({ err }, 'Keeper health queue check failed');
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Queue health check failed' }));
        });
      return;
    }

    if (req.method === 'GET' && url === '/health/redis') {
      getQueueHealth(queues)
        .then((summary) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            redisStatus: summary.redisStatus,
            overallStatus: summary.overallStatus,
            timestamp: summary.timestamp,
          }));
        })
        .catch((err: unknown) => {
          logger.error({ err }, 'Redis health check failed');
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Redis health check failed' }));
        });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    logger.info({ port }, 'Keeper health server listening');
  });

  return server;
}
