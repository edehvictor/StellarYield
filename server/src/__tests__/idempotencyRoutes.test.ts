/**
 * End-to-end idempotency on the real money-moving routes: a retried request
 * with the same Idempotency-Key must not create a second withdrawal (offramp)
 * or a second PENDING deposit (onramp).
 */
import express, { Express, Router } from 'express';
import request from 'supertest';
import { InMemoryIdempotencyStore, setDefaultIdempotencyStore } from '../middleware/idempotency';

const createTx = jest.fn();
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    onRampTransaction: { create: createTx, findUnique: jest.fn(), update: jest.fn() },
  })),
}));

function mount(path: string, router: Router): Express {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

beforeEach(() => {
  setDefaultIdempotencyStore(new InMemoryIdempotencyStore());
  createTx.mockReset();
});
afterAll(() => setDefaultIdempotencyStore(null));

describe('POST /api/offramp/withdrawals', () => {
  const realFetch = global.fetch;
  let app: Express;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.OFFRAMP_API_KEY = 'test-key';
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      app = mount('/api/offramp', require('../routes/offramp').default);
    });
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.OFFRAMP_API_KEY;
    jest.restoreAllMocks();
  });

  const body = { walletAddress: 'GABC', amount: '250.00', currency: 'usd' };

  it('calls the provider once for a retried key and replays its response', async () => {
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({ id: 'mp_wd_1' }) });

    const first = await request(app).post('/api/offramp/withdrawals').set('Idempotency-Key', 'wd-123').send(body);
    const retry = await request(app).post('/api/offramp/withdrawals').set('Idempotency-Key', 'wd-123').send(body);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ id: 'mp_wd_1' });
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });

  it('lets the same key retry after a provider outage (502 is not stored)', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ status: 201, json: async () => ({ id: 'mp_wd_2' }) });

    const failed = await request(app).post('/api/offramp/withdrawals').set('Idempotency-Key', 'wd-9').send(body);
    const retry = await request(app).post('/api/offramp/withdrawals').set('Idempotency-Key', 'wd-9').send(body);

    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe('OFFRAMP_PROXY_ERROR');
    expect(retry.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects the same key with a different amount', async () => {
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({ id: 'mp_wd_1' }) });
    await request(app).post('/api/offramp/withdrawals').set('Idempotency-Key', 'wd-1').send(body);
    const res = await request(app)
      .post('/api/offramp/withdrawals')
      .set('Idempotency-Key', 'wd-1')
      .send({ ...body, amount: '9999.00' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is unchanged for clients that send no key', async () => {
    fetchMock.mockResolvedValue({ status: 201, json: async () => ({ id: 'x' }) });
    await request(app).post('/api/offramp/withdrawals').send(body);
    await request(app).post('/api/offramp/withdrawals').send(body);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/onramp/intent', () => {
  let app: Express;

  beforeEach(() => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      app = mount('/api/onramp', require('../routes/onramp').default);
    });
  });

  it('creates one PENDING transaction for a retried key', async () => {
    createTx.mockImplementation(async ({ data }) => ({ id: 'row-1', ...data }));
    const quote = await request(app).post('/api/onramp/quote').send({ amountFiat: 100, currency: 'USD' });
    const body = { quoteId: quote.body.quoteId, walletAddress: 'GABC' };

    const first = await request(app).post('/api/onramp/intent').set('Idempotency-Key', 'dep-1').send(body);
    const retry = await request(app).post('/api/onramp/intent').set('Idempotency-Key', 'dep-1').send(body);

    expect(createTx).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(retry.body.transaction.providerTxId).toBe(first.body.transaction.providerTxId);
  });

  it('still creates a new transaction per distinct key', async () => {
    createTx.mockImplementation(async ({ data }) => ({ id: 'row', ...data }));
    const quote = await request(app).post('/api/onramp/quote').send({ amountFiat: 100, currency: 'USD' });
    const body = { quoteId: quote.body.quoteId, walletAddress: 'GABC' };
    await request(app).post('/api/onramp/intent').set('Idempotency-Key', 'dep-a').send(body);
    await request(app).post('/api/onramp/intent').set('Idempotency-Key', 'dep-b').send(body);
    expect(createTx).toHaveBeenCalledTimes(2);
  });
});
