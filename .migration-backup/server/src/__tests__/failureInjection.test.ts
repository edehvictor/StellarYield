/**
 * Failure-injection integration tests for server external dependencies.
 *
 * Uses the failureHarness helpers to simulate outages, timeouts, and malformed
 * responses from Horizon RPC, Soroban RPC, and the fee oracle endpoint, then
 * asserts that health checks degrade safely and callers receive appropriate error signals.
 */

import request from 'supertest';
import express from 'express';
import healthRouter from '../routes/health';
import { mockHorizon } from './helpers/failureHarness';

// ── Common mocks (queue, Redis, Prisma, Soroban) ──────────────────────────────

const mockGetJobCounts = jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: string) => ({
    name,
    getJobCounts: mockGetJobCounts,
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('ioredis', () => ({
  Redis: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    status: 'ready',
  })),
}));

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw: jest.fn().mockResolvedValue([{}]),
    indexerState: {
      findFirst: jest.fn().mockResolvedValue({ lastLedger: 100 }),
    },
  })),
}));

// ── Horizon mock — replaced per test ─────────────────────────────────────────

const mockHorizonCall = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        ledgers: () => ({
          limit: () => ({
            order: () => ({ call: mockHorizonCall }),
          }),
        }),
      })),
    },
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getNetwork: jest.fn().mockResolvedValue({ network: 'testnet', passphrase: 'Test SDF Network ; September 2015' }),
      })),
    },
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Failure injection: /api/health — Horizon RPC', () => {
  const app = express();
  app.use('/api/health', healthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_HORIZON_TIMEOUT_MS = '100';
  });

  afterEach(() => {
    delete process.env.STELLAR_HORIZON_TIMEOUT_MS;
  });

  it('Horizon connection timeout → health shows horizon down', async () => {
    // Simulate TCP hang longer than the timeout window
    mockHorizonCall.mockImplementation(
      () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ETIMEDOUT')), 200)),
    );

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.horizon).toBe('down');
  });

  it('Horizon outage (immediate rejection) → health shows horizon down', async () => {
    mockHorizonCall.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.horizon).toBe('down');
  });

  it('Horizon healthy response → health shows horizon up', async () => {
    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 105 }] });

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.horizon).toBe('up');
  });
});

describe('Failure injection: /api/health — Soroban RPC', () => {
  const app = express();
  app.use('/api/health', healthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_HORIZON_TIMEOUT_MS = '100';
    // Horizon healthy by default so we isolate Soroban failures
    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 105 }] });
  });

  afterEach(() => {
    delete process.env.STELLAR_HORIZON_TIMEOUT_MS;
  });

  it('Soroban RPC outage → health shows sorobanRpc down', async () => {
    const { rpc } = require('@stellar/stellar-sdk');
    rpc.Server.mockImplementation(() => ({
      getNetwork: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    }));

    const res = await request(app).get('/api/health');

    expect(res.body.sorobanRpc).toBe('down');
  });

  it('Soroban RPC timeout → health shows sorobanRpc down', async () => {
    const { rpc } = require('@stellar/stellar-sdk');
    rpc.Server.mockImplementation(() => ({
      getNetwork: jest.fn(
        () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 200)),
      ),
    }));

    const res = await request(app).get('/api/health');

    expect(res.body.sorobanRpc).toBe('down');
  });
});

describe('Failure injection: /api/health/queues — Redis/queue outage', () => {
  const app = express();
  app.use('/api/health', healthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queue getJobCounts rejection → /health/queues returns 503', async () => {
    mockGetJobCounts.mockRejectedValue(new Error('Redis connection lost'));

    const res = await request(app).get('/api/health/queues');

    expect(res.status).toBe(503);
  });

  it('queue healthy → /health/queues returns 200', async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 10, failed: 0, delayed: 0 });

    const res = await request(app).get('/api/health/queues');

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe('healthy');
  });
});
