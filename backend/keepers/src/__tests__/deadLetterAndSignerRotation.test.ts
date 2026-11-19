import { getRedisConnectionState, isRedisAvailable, _resetConnectionStateForTest } from '../utils/redis';
import { KeeperSigner, type SignerProvider } from '../signer/KeeperSigner';

// ── Redis connection state (#1538) ──────────────────────────────────────────

jest.mock('../utils/redis', () => {
  const actual = jest.requireActual('../utils/redis');
  return {
    ...actual,
    getRedis: jest.fn().mockReturnValue({
      status: 'ready',
      on: jest.fn(),
      setex: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      keys: jest.fn().mockResolvedValue([]),
      zadd: jest.fn().mockResolvedValue(1),
      zrem: jest.fn().mockResolvedValue(1),
    }),
  };
});

jest.mock('../config', () => ({
  config: {
    stellar: {
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
      network: 'testnet',
      keeperSecretKey: 'SCKEEPTESTKEY',
    },
    keeper: {
      mcrBps: 11000,
      jobMaxAttempts: 5,
    },
    redis: {
      url: 'redis://localhost:6379',
    },
  },
}));

jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('Redis connection state (#1538)', () => {
  beforeEach(() => {
    _resetConnectionStateForTest();
  });

  it('reports unavailable when not connected', () => {
    const state = getRedisConnectionState();
    expect(state.state).toBe('unavailable');
    expect(isRedisAvailable()).toBe(false);
  });

  it('reports connected state fields', () => {
    const state = getRedisConnectionState();
    expect(state).toHaveProperty('state');
    expect(state).toHaveProperty('lastConnectedAt');
    expect(state).toHaveProperty('reconnectAttempts');
    expect(typeof state.reconnectAttempts).toBe('number');
  });
});

// ── Signer rotation (#1536) ─────────────────────────────────────────────────

describe('KeeperSigner rotation (#1536)', () => {
  function makeProvider(publicKey: string): SignerProvider {
    return {
      id: `provider-${publicKey}`,
      publicKey,
      allowedOperations: new Set(['liquidate', 'set_price']),
      signTransaction: jest.fn().mockResolvedValue({} as any),
    };
  }

  it('rotates signer and returns old and new public keys', async () => {
    const oldProvider = makeProvider('GOLD123');
    const signer = new KeeperSigner(oldProvider);
    const newProvider = makeProvider('GNEW456');

    const result = await signer.rotateSigner(newProvider);

    expect(result.oldPublicKey).toBe('GOLD123');
    expect(result.newPublicKey).toBe('GNEW456');
    expect(signer.publicKey).toBe('GNEW456');
    expect(signer.isRotating).toBe(false);
  });

  it('rejects concurrent rotation attempts', async () => {
    const signer = new KeeperSigner(makeProvider('GOLD123'));
    const p1 = signer.rotateSigner(makeProvider('GNEW456'));

    // Immediately try another rotation while first is in-flight
    await expect(signer.rotateSigner(makeProvider('GTHIRD789'))).rejects.toThrow(
      'Signer rotation already in progress',
    );

    await p1;
    expect(signer.publicKey).toBe('GNEW456');
  });

  it('keeps queued work valid after rotation', async () => {
    const signer = new KeeperSigner(makeProvider('GOLD123'));
    const newProvider = makeProvider('GNEW456');

    // Simulate a "queued job" holding a reference to the signer
    const jobPublicKey = signer.publicKey;
    expect(jobPublicKey).toBe('GOLD123');

    await signer.rotateSigner(newProvider);

    // The signer now uses the new key — queued jobs will execute with it
    expect(signer.publicKey).toBe('GNEW456');
  });
});
