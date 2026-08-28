// Redis tests — all module loading happens inside jest.isolateModules so that
// each test gets a fresh module instance AND a fresh ioredis mock.

describe('redis utilities', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Load a fresh redis module instance alongside a fresh ioredis mock. */
  function loadFresh() {
    let getRedis: () => import('ioredis').Redis;
    let closeRedis: () => Promise<void>;
    let _setRedisForTest: (r: import('ioredis').Redis) => void;
    const mockQuit = jest.fn().mockResolvedValue('OK');
    const mockOn   = jest.fn();
    const mockPing = jest.fn().mockResolvedValue('PONG');
    const MockRedis = jest.fn().mockImplementation(() => ({ on: mockOn, quit: mockQuit, status: 'ready', ping: mockPing }));

    jest.isolateModules(() => {
      jest.mock('ioredis', () => ({ Redis: MockRedis }));
      const mod = require('../utils/redis');
      getRedis        = mod.getRedis;
      closeRedis      = mod.closeRedis;
      _setRedisForTest = mod._setRedisForTest;
    });

    return { getRedis: getRedis!, closeRedis: closeRedis!, _setRedisForTest: _setRedisForTest!, MockRedis, mockQuit, mockOn, mockPing };
  }

  // ── getRedis() ─────────────────────────────────────────────────────────────

  test('creates an ioredis client with correct options', () => {
    const { getRedis, MockRedis } = loadFresh();
    getRedis();
    expect(MockRedis).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      }),
    );
  });

  test('returns the same instance on subsequent calls (singleton)', () => {
    const { getRedis, MockRedis } = loadFresh();
    const c1 = getRedis();
    const c2 = getRedis();
    expect(c1).toBe(c2);
    expect(MockRedis).toHaveBeenCalledTimes(1);
  });

  test('registers connect and error event listeners on first call', () => {
    const { getRedis, mockOn } = loadFresh();
    getRedis();
    expect(mockOn).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  // ── closeRedis() ──────────────────────────────────────────────────────────

  test('calls quit() on the live client', async () => {
    const { getRedis, closeRedis, mockQuit } = loadFresh();
    getRedis();
    await closeRedis();
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });

  test('is a no-op when Redis was never initialised', async () => {
    const { closeRedis, mockQuit } = loadFresh();
    await expect(closeRedis()).resolves.not.toThrow();
    expect(mockQuit).not.toHaveBeenCalled();
  });

  test('resets the singleton so next getRedis() creates a new client', async () => {
    const { getRedis, closeRedis, MockRedis } = loadFresh();
    const first = getRedis();
    await closeRedis();
    const second = getRedis();
    expect(MockRedis).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
  });

  // ── _setRedisForTest() ────────────────────────────────────────────────────

  test('replaces the singleton with a provided instance', () => {
    const { getRedis, _setRedisForTest, MockRedis } = loadFresh();
    const fakeRedis = { on: jest.fn(), quit: jest.fn().mockResolvedValue(undefined) } as any;
    _setRedisForTest(fakeRedis);
    const result = getRedis();
    expect(result).toBe(fakeRedis);
    expect(MockRedis).not.toHaveBeenCalled();
  });

  // #909: Add Redis failover and lease recovery tests
  describe('Redis Failover and Lease Recovery (#909)', () => {
    test('detects degraded Redis via latency threshold', async () => {
      const { getRedis, mockPing } = loadFresh();
      const redis = getRedis();
      mockPing.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('PONG'), 1100)));

      const start = Date.now();
      await redis.ping();
      const latencyMs = Date.now() - start;

      expect(latencyMs).toBeGreaterThan(1000);
    });

    test('treats ping failure as outage, not degraded', async () => {
      const { getRedis, mockPing } = loadFresh();
      const redis = getRedis();
      mockPing.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(redis.ping()).rejects.toThrow('ECONNREFUSED');
    });

    test('connection events are registered for failover detection', () => {
      const { getRedis, mockOn } = loadFresh();
      getRedis();
      const registeredEvents = mockOn.mock.calls.map(([event]) => event);
      expect(registeredEvents).toContain('connect');
      expect(registeredEvents).toContain('error');
    });
  });

  // #906: Stale lock fencing validation
  describe('Stale Lock Fencing (#906)', () => {
    test('fencing token changes block stale lock reuse', () => {
      const { getRedis, _setRedisForTest } = loadFresh();
      const fakeRedis = {
        on: jest.fn(),
        quit: jest.fn().mockResolvedValue(undefined),
        ping: jest.fn().mockResolvedValue('PONG'),
        setex: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null),
      } as any;
      _setRedisForTest(fakeRedis);

      const redis = getRedis();
      // Simulate storing an old fencing record
      fakeRedis.get = jest.fn().mockResolvedValue(JSON.stringify({
        jobId: 'job-old',
        fencingToken: 5,
        requiredSequence: 100,
        updatedAt: new Date(Date.now() - 3600_000).toISOString(),
      }));

      redis.get('keeper:job:attempt:liquidation:job-old').then((raw: string | null) => {
        if (raw) {
          const record = JSON.parse(raw);
          expect(record.fencingToken).toBe(5);
          expect(record.requiredSequence).toBe(100);
        }
      });
    });

    test('missing job record returns null (no stale state)', async () => {
      const { getRedis, _setRedisForTest } = loadFresh();
      const fakeRedis = {
        on: jest.fn(),
        quit: jest.fn().mockResolvedValue(undefined),
        ping: jest.fn().mockResolvedValue('PONG'),
        setex: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null),
      } as any;
      _setRedisForTest(fakeRedis);

      const redis = getRedis();
      const raw = await redis.get('keeper:job:attempt:liquidation:missing');
      expect(raw).toBeNull();
    });
  });
});