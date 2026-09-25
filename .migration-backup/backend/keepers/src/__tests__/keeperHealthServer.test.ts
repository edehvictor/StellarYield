import http from 'http';
import { startKeeperHealthServer } from '../api/queueHealth';
import type { Queue } from 'bullmq';
import { getQueueHealth } from '../queues';

jest.mock('../queues', () => ({
  getQueueHealth: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../audit/KeeperAuditLog', () => ({
  keeperAuditLog: { exportStream: jest.fn().mockReturnValue([]) },
}));

jest.mock('../monitors/LedgerLagMonitor', () => ({
  ledgerLagMonitor: { getSnapshot: jest.fn().mockReturnValue({ dataFreshnessMs: null, lagStatus: 'unknown', lastSuccessAt: null }) },
  DEFAULT_STALE_THRESHOLD_MS: 90_000,
}));

const mockGetQueueHealth = getQueueHealth as jest.MockedFunction<typeof getQueueHealth>;

function makeQueue(name: string): Queue {
  return { name, getJobCounts: jest.fn() } as unknown as Queue;
}

function httpGet(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let raw = '';
      res.on('data', (chunk: string) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.on('error', reject);
  });
}

function startAndGetPort(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.once('listening', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

describe('startKeeperHealthServer', () => {
  let server: http.Server;

  afterEach((done) => {
    server.close(done);
    jest.clearAllMocks();
  });

  it('GET /health returns 200 with status ok and uptime', async () => {
    server = startKeeperHealthServer([], 0);
    const port = await startAndGetPort(server);
    const { status, body } = await httpGet(port, '/health');

    expect(status).toBe(200);
    expect((body as any).status).toBe('ok');
    expect(typeof (body as any).uptime).toBe('number');
  });

  it('GET /health/queues returns 200 with queue summary when healthy', async () => {
    const summary = {
      queues: [{ name: 'liquidation', counts: { pending: 0, waiting: 0, active: 0, completed: 5, failed: 0, delayed: 0, poison: 0 }, status: 'healthy' as const, warnings: [] as string[] }],
      overallStatus: 'healthy' as const,
      timestamp: new Date().toISOString(),
      redisStatus: 'healthy' as const,
    };
    mockGetQueueHealth.mockResolvedValue(summary);

    server = startKeeperHealthServer([makeQueue('liquidation')], 0);
    const port = await startAndGetPort(server);

    const { status, body } = await httpGet(port, '/health/queues');

    expect(status).toBe(200);
    expect((body as any).overallStatus).toBe('healthy');
    expect(Array.isArray((body as any).queues)).toBe(true);
  });

  it('GET /health/queues returns 200 with warning overallStatus when queues are degraded', async () => {
    const summary = {
      queues: [{ name: 'liquidation', counts: { pending: 0, waiting: 0, active: 0, completed: 0, failed: 15, delayed: 0, poison: 0 }, status: 'degraded' as const, warnings: ['failed jobs (15) exceed threshold (10)'] }],
      overallStatus: 'degraded' as const,
      timestamp: new Date().toISOString(),
      redisStatus: 'healthy' as const,
    };
    mockGetQueueHealth.mockResolvedValue(summary);

    server = startKeeperHealthServer([makeQueue('liquidation')], 0);
    const port = await startAndGetPort(server);

    const { status, body } = await httpGet(port, '/health/queues');

    expect(status).toBe(200);
    expect((body as any).overallStatus).toBe('degraded');
  });

  it('GET /health/queues returns 503 when getQueueHealth throws', async () => {
    mockGetQueueHealth.mockRejectedValue(new Error('Redis connection lost'));

    server = startKeeperHealthServer([makeQueue('liquidation')], 0);
    const port = await startAndGetPort(server);

    const { status, body } = await httpGet(port, '/health/queues');

    expect(status).toBe(503);
    expect((body as any).error).toBeDefined();
  });

  it('unknown routes return 404', async () => {
    server = startKeeperHealthServer([], 0);
    const port = await startAndGetPort(server);

    const { status } = await httpGet(port, '/unknown');
    expect(status).toBe(404);
  });

  describe('GET /audit/export', () => {
    it('returns 400 when the "stream" query parameter is missing', async () => {
      server = startKeeperHealthServer([], 0);
      const port = await startAndGetPort(server);

      const { status, body } = await httpGet(port, '/audit/export');

      expect(status).toBe(400);
      expect((body as any).error).toBeDefined();
    });

    it('returns 200 with the bounded records from the injected audit log', async () => {
      const exportStream = jest.fn().mockReturnValue([{ id: 'r1', seq: 0 }]);

      server = startKeeperHealthServer([], 0, { exportStream });
      const port = await startAndGetPort(server);

      const { status, body } = await httpGet(port, '/audit/export?stream=compound&from=2026-01-01&to=2026-02-01');

      expect(status).toBe(200);
      expect(exportStream).toHaveBeenCalledWith('compound', '2026-01-01', '2026-02-01');
      expect((body as any).count).toBe(1);
      expect((body as any).records).toEqual([{ id: 'r1', seq: 0 }]);
    });

    it('returns 500 when the audit log throws', async () => {
      const exportStream = jest.fn().mockImplementation(() => {
        throw new Error('disk error');
      });

      server = startKeeperHealthServer([], 0, { exportStream });
      const port = await startAndGetPort(server);

      const { status, body } = await httpGet(port, '/audit/export?stream=compound');

      expect(status).toBe(500);
      expect((body as any).error).toBeDefined();
    });
  });

  // ── #1298: /health/data — ledger lag indicator ──────────────────────────

  describe('GET /health/data', () => {
    it('returns 200 with lagStatus "unknown" before any ledger read', async () => {
      const lagMonitor = { getSnapshot: jest.fn().mockReturnValue({ dataFreshnessMs: null, lagStatus: 'unknown', lastSuccessAt: null }) };
      server = startKeeperHealthServer([], 0, undefined, lagMonitor);
      const port = await startAndGetPort(server);

      const { status, body } = await httpGet(port, '/health/data');

      expect(status).toBe(200);
      expect((body as any).lagStatus).toBe('unknown');
      expect((body as any).dataFreshnessMs).toBeNull();
      expect((body as any).lastSuccessAt).toBeNull();
      expect(typeof (body as any).timestamp).toBe('string');
    });

    it('returns 200 with lagStatus "fresh" when data is recent', async () => {
      const lagMonitor = { getSnapshot: jest.fn().mockReturnValue({ dataFreshnessMs: 15_000, lagStatus: 'fresh', lastSuccessAt: new Date().toISOString() }) };
      server = startKeeperHealthServer([], 0, undefined, lagMonitor);
      const port = await startAndGetPort(server);

      const { status, body } = await httpGet(port, '/health/data');

      expect(status).toBe(200);
      expect((body as any).lagStatus).toBe('fresh');
      expect((body as any).dataFreshnessMs).toBe(15_000);
    });

    it('returns 200 with lagStatus "stale" when data exceeds the threshold', async () => {
      const lagMonitor = { getSnapshot: jest.fn().mockReturnValue({ dataFreshnessMs: 120_000, lagStatus: 'stale', lastSuccessAt: new Date(Date.now() - 120_000).toISOString() }) };
      server = startKeeperHealthServer([], 0, undefined, lagMonitor);
      const port = await startAndGetPort(server);

      const { status, body } = await httpGet(port, '/health/data');

      expect(status).toBe(200);
      expect((body as any).lagStatus).toBe('stale');
      expect((body as any).dataFreshnessMs).toBe(120_000);
      expect(typeof (body as any).lastSuccessAt).toBe('string');
    });
  });
});
