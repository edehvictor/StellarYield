import express, { Express, Request, Response } from 'express';
import request from 'supertest';
import {
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  canonicalJson,
  idempotency,
  type IdempotencyStore,
  type RedisLike,
} from '../middleware/idempotency';

type Handler = (req: Request, res: Response) => void | Promise<void>;

function buildApp(handler: Handler, opts: { store?: IdempotencyStore; required?: boolean; scope?: string } = {}) {
  const store = opts.store ?? new InMemoryIdempotencyStore();
  const app = express();
  app.use(express.json());
  app.post('/withdraw', idempotency({ scope: opts.scope ?? 'test.withdraw', store, required: opts.required }), handler);
  return { app, store };
}

/** Handler that "creates" a withdrawal and counts side effects. */
function countingHandler() {
  let calls = 0;
  const handler: Handler = (req, res) => {
    calls += 1;
    res.status(201).json({ id: `wd_${calls}`, amount: req.body.amount });
  };
  return { handler, calls: () => calls };
}

const post = (app: Express, key: string | undefined, body: object) => {
  const r = request(app).post('/withdraw').send(body);
  return key === undefined ? r : r.set(IDEMPOTENCY_HEADER, key);
};

describe('idempotency middleware', () => {
  it('runs the handler once and replays the stored response for a retried key', async () => {
    const h = countingHandler();
    const { app } = buildApp(h.handler);

    const first = await post(app, 'key-1', { amount: 100 });
    const retry = await post(app, 'key-1', { amount: 100 });

    expect(h.calls()).toBe(1);
    expect(first.status).toBe(201);
    expect(first.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ id: 'wd_1', amount: 100 });
    expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
  });

  it('treats different keys as different requests', async () => {
    const h = countingHandler();
    const { app } = buildApp(h.handler);
    await post(app, 'key-a', { amount: 100 });
    await post(app, 'key-b', { amount: 100 });
    expect(h.calls()).toBe(2);
  });

  it('keeps legacy behaviour when no key is sent', async () => {
    const h = countingHandler();
    const { app } = buildApp(h.handler);
    await post(app, undefined, { amount: 100 });
    await post(app, undefined, { amount: 100 });
    expect(h.calls()).toBe(2);
  });

  it('rejects a reused key with a different body (422 IDEMPOTENCY_KEY_REUSED)', async () => {
    const h = countingHandler();
    const { app } = buildApp(h.handler);
    await post(app, 'key-1', { amount: 100 });
    const res = await post(app, 'key-1', { amount: 999 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(h.calls()).toBe(1);
  });

  it('fingerprints bodies independent of key order', async () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 0, f: 1 }], d: 2 }, b: 1 }),
    );
    const h = countingHandler();
    const { app } = buildApp(h.handler);
    await post(app, 'key-1', { amount: 100, asset: 'USDC' });
    const res = await post(app, 'key-1', { asset: 'USDC', amount: 100 });
    expect(res.status).toBe(201);
    expect(h.calls()).toBe(1);
  });

  it('returns 409 IDEMPOTENCY_REQUEST_IN_PROGRESS while the first request is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { app } = buildApp(async (_req, res) => {
      calls += 1;
      await gate;
      res.status(201).json({ id: 'wd_1' });
    });

    const first = post(app, 'key-1', { amount: 100 }).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const concurrent = await post(app, 'key-1', { amount: 100 });

    expect(concurrent.status).toBe(409);
    expect(concurrent.body).toMatchObject({ error: 'IDEMPOTENCY_REQUEST_IN_PROGRESS', recoverable: true });
    expect(concurrent.headers['retry-after']).toBe('1');

    release();
    expect((await first).status).toBe(201);
    expect(calls).toBe(1);
  });

  it('stores deterministic 4xx results', async () => {
    let calls = 0;
    const { app } = buildApp((_req, res) => {
      calls += 1;
      res.status(400).json({ error: 'INVALID_AMOUNT' });
    });
    await post(app, 'key-1', { amount: -1 });
    const retry = await post(app, 'key-1', { amount: -1 });
    expect(retry.status).toBe(400);
    expect(retry.body.error).toBe('INVALID_AMOUNT');
    expect(calls).toBe(1);
  });

  it('does not store 5xx results, so the same key can be retried', async () => {
    let calls = 0;
    const { app } = buildApp((_req, res) => {
      calls += 1;
      if (calls === 1) res.status(502).json({ error: 'OFFRAMP_PROXY_ERROR' });
      else res.status(201).json({ id: 'wd_2' });
    });
    expect((await post(app, 'key-1', { amount: 100 })).status).toBe(502);
    const retry = await post(app, 'key-1', { amount: 100 });
    expect(retry.status).toBe(201);
    expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('releases the key when the handler throws', async () => {
    let calls = 0;
    const store = new InMemoryIdempotencyStore();
    const app = express();
    app.use(express.json());
    app.post('/withdraw', idempotency({ scope: 's', store }), (_req, res) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      res.status(201).json({ ok: true });
    });
    expect((await post(app, 'key-1', {})).status).toBe(500);
    expect((await post(app, 'key-1', {})).status).toBe(201);
    expect(calls).toBe(2);
  });

  it.each(['', 'has space', 'x'.repeat(256), 'key/with/slash'])('rejects malformed key %p with 400', async (key) => {
    const h = countingHandler();
    const { app } = buildApp(h.handler);
    const res = await post(app, key, { amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(h.calls()).toBe(0);
  });

  it('requires a key when configured (400 IDEMPOTENCY_KEY_REQUIRED)', async () => {
    const h = countingHandler();
    const { app } = buildApp(h.handler, { required: true });
    const res = await post(app, undefined, { amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(h.calls()).toBe(0);
  });

  it('fails closed with 503 when the store is unreachable', async () => {
    const h = countingHandler();
    const broken: IdempotencyStore = {
      reserve: () => Promise.reject(new Error('ECONNREFUSED')),
      complete: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    const { app } = buildApp(h.handler, { store: broken });
    const res = await post(app, 'key-1', { amount: 100 });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'IDEMPOTENCY_STORE_UNAVAILABLE', recoverable: true });
    expect(res.body.message).not.toContain('ECONNREFUSED');
    expect(h.calls()).toBe(0);
  });

  it('scopes keys per endpoint', async () => {
    const store = new InMemoryIdempotencyStore();
    const a = countingHandler();
    const b = countingHandler();
    const appA = buildApp(a.handler, { store, scope: 'deposit' }).app;
    const appB = buildApp(b.handler, { store, scope: 'withdraw' }).app;
    await post(appA, 'shared', { amount: 1 });
    const res = await post(appB, 'shared', { amount: 2 });
    expect(res.status).toBe(201);
    expect(b.calls()).toBe(1);
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('forgets keys after the TTL', async () => {
    let now = 0;
    const store = new InMemoryIdempotencyStore(100, () => now);
    const r1 = await store.reserve('k', 'fp', 1_000);
    expect(r1.reserved).toBe(true);
    expect((await store.reserve('k', 'fp', 1_000)).reserved).toBe(false);
    now = 1_001;
    expect((await store.reserve('k', 'fp', 1_000)).reserved).toBe(true);
  });

  it('stays bounded by evicting the oldest keys', async () => {
    const store = new InMemoryIdempotencyStore(3);
    for (const k of ['a', 'b', 'c', 'd']) await store.reserve(k, 'fp', 60_000);
    expect(store.size).toBe(3);
    expect((await store.reserve('a', 'fp', 60_000)).reserved).toBe(true);
  });

  it('ignores complete/release from a stale token', async () => {
    const store = new InMemoryIdempotencyStore();
    const r = await store.reserve('k', 'fp', 60_000);
    if (!r.reserved) throw new Error('expected reservation');
    await store.release('k', 'someone-else');
    await store.complete('k', 'someone-else', 'fp', { status: 200, body: {} }, 60_000);
    const again = await store.reserve('k', 'fp', 60_000);
    expect(again).toMatchObject({ reserved: false, existing: { state: 'in_progress' } });
  });
});

/** Minimal in-memory stand-in for the ioredis commands the store uses. */
class FakeRedis implements RedisLike {
  data = new Map<string, string>();
  async set(key: string, value: string, _px: 'PX', _ttl: number, nx?: 'NX'): Promise<'OK' | null> {
    if (nx === 'NX' && this.data.has(key)) return null;
    this.data.set(key, value);
    return 'OK';
  }
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async del(key: string) {
    return this.data.delete(key) ? 1 : 0;
  }
}

describe('RedisIdempotencyStore', () => {
  it('reserves atomically, completes, and replays through the middleware', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdempotencyStore(redis);
    const h = countingHandler();
    const { app } = buildApp(h.handler, { store });

    await post(app, 'key-1', { amount: 100 });
    await new Promise((r) => setImmediate(r));
    const retry = await post(app, 'key-1', { amount: 100 });

    expect(h.calls()).toBe(1);
    expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(JSON.parse(redis.data.get('idempotency:test.withdraw:key-1')!)).toMatchObject({
      state: 'completed',
      response: { status: 201 },
    });
  });

  it('only one of two concurrent reservations wins', async () => {
    const store = new RedisIdempotencyStore(new FakeRedis());
    const [a, b] = await Promise.all([store.reserve('k', 'fp', 1000), store.reserve('k', 'fp', 1000)]);
    expect([a.reserved, b.reserved].sort()).toEqual([false, true]);
  });

  it('release deletes only its own in-progress reservation', async () => {
    const redis = new FakeRedis();
    const store = new RedisIdempotencyStore(redis);
    const r = await store.reserve('k', 'fp', 1000);
    if (!r.reserved) throw new Error('expected reservation');
    await store.release('k', 'other');
    expect(redis.data.size).toBe(1);
    await store.release('k', r.token);
    expect(redis.data.size).toBe(0);
  });
});
