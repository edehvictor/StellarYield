// Config tests — use jest.isolateModules to load the module with different
// env vars per test without polluting the Node module cache across tests.

const VALID_ENV = {
  STELLAR_NETWORK: 'testnet',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  KEEPER_SECRET_KEY: 'STEST000',
  BASE_FEE: '150',
  VAULT_CONTRACT_ID: 'CVAULT',
  STABLECOIN_MANAGER_CONTRACT_ID: 'CSTABLE',
  REDIS_URL: 'redis://localhost:6380',
  SCAN_INTERVAL_MS: '15000',
  MCR_BPS: '12000',
  LIQUIDATION_CONCURRENCY: '2',
  COMPOUND_CONCURRENCY: '4',
  JOB_MAX_ATTEMPTS: '3',
  LOG_LEVEL: 'debug',
};

/** Load the config module in an isolated module scope with the given env vars. */
function loadConfig(env: Record<string, string | undefined> = {}) {
  // Save & restore process.env around each isolated load
  const saved = { ...process.env };
  // Wipe all keys that the config module reads so defaults are predictable
  Object.keys(VALID_ENV).forEach((k) => delete process.env[k]);
  // Assign non-undefined values, and delete undefined ones
  Object.entries(env).forEach(([k, v]) => {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  });

  let cfg: typeof import('../config').config;
  jest.isolateModules(() => {
    cfg = require('../config').config;
  });

  // Restore
  Object.keys(VALID_ENV).forEach((k) => delete process.env[k]);
  Object.assign(process.env, saved);

  return cfg!;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('config', () => {
  // ── Stellar ──────────────────────────────────────────────────────────────────

  test('reads STELLAR_NETWORK from env', () => {
    const cfg = loadConfig({ ...VALID_ENV, STELLAR_NETWORK: 'mainnet' });
    expect(cfg.stellar.network).toBe('mainnet');
  });

  test('defaults STELLAR_NETWORK to "testnet"', () => {
    const cfg = loadConfig({ ...VALID_ENV, STELLAR_NETWORK: undefined });
    expect(cfg.stellar.network).toBe('testnet');
  });

  test('reads STELLAR_SOROBAN_RPC_URL from env', () => {
    const cfg = loadConfig({ ...VALID_ENV, STELLAR_SOROBAN_RPC_URL: 'https://custom-rpc.example.com' });
    expect(cfg.stellar.sorobanRpcUrl).toBe('https://custom-rpc.example.com');
  });

  test('reads KEEPER_SECRET_KEY from env', () => {
    const cfg = loadConfig({ ...VALID_ENV, KEEPER_SECRET_KEY: 'SMYSECRET' });
    expect(cfg.stellar.keeperSecretKey).toBe('SMYSECRET');
  });

  test('reads BASE_FEE as integer', () => {
    const cfg = loadConfig({ ...VALID_ENV, BASE_FEE: '500' });
    expect(cfg.stellar.baseFee).toBe(500);
  });

  test('defaults BASE_FEE to 100', () => {
    const cfg = loadConfig({ ...VALID_ENV, BASE_FEE: undefined });
    expect(cfg.stellar.baseFee).toBe(100);
  });

  test('throws on non-integer BASE_FEE', () => {
    expect(() => loadConfig({ ...VALID_ENV, BASE_FEE: 'notanumber' })).toThrow(
      'must be an integer',
    );
  });

  // ── Contracts ─────────────────────────────────────────────────────────────────

  test('reads VAULT_CONTRACT_ID from env', () => {
    const cfg = loadConfig({ ...VALID_ENV, VAULT_CONTRACT_ID: 'CMYVAULT' });
    expect(cfg.contracts.vault).toBe('CMYVAULT');
  });

  test('reads STABLECOIN_MANAGER_CONTRACT_ID from env', () => {
    const cfg = loadConfig({ ...VALID_ENV, STABLECOIN_MANAGER_CONTRACT_ID: 'CMYSTABLE' });
    expect(cfg.contracts.stablecoinManager).toBe('CMYSTABLE');
  });

  // ── Redis ─────────────────────────────────────────────────────────────────────

  test('reads REDIS_URL from env', () => {
    const cfg = loadConfig({ ...VALID_ENV, REDIS_URL: 'redis://redis-host:6380' });
    expect(cfg.redis.url).toBe('redis://redis-host:6380');
  });

  test('defaults REDIS_URL to "redis://localhost:6379"', () => {
    const cfg = loadConfig({ ...VALID_ENV, REDIS_URL: undefined });
    expect(cfg.redis.url).toBe('redis://localhost:6379');
  });

  // ── Keeper ────────────────────────────────────────────────────────────────────

  test('reads SCAN_INTERVAL_MS as integer', () => {
    const cfg = loadConfig({ ...VALID_ENV, SCAN_INTERVAL_MS: '60000' });
    expect(cfg.keeper.scanIntervalMs).toBe(60000);
  });

  test('defaults SCAN_INTERVAL_MS to 30000', () => {
    const cfg = loadConfig({ ...VALID_ENV, SCAN_INTERVAL_MS: undefined });
    expect(cfg.keeper.scanIntervalMs).toBe(30000);
  });

  test('reads MCR_BPS as integer', () => {
    const cfg = loadConfig({ ...VALID_ENV, MCR_BPS: '12000' });
    expect(cfg.keeper.mcrBps).toBe(12000);
  });

  test('defaults MCR_BPS to 11000', () => {
    const cfg = loadConfig({ ...VALID_ENV, MCR_BPS: undefined });
    expect(cfg.keeper.mcrBps).toBe(11000);
  });

  test('reads LIQUIDATION_CONCURRENCY as integer', () => {
    const cfg = loadConfig({ ...VALID_ENV, LIQUIDATION_CONCURRENCY: '5' });
    expect(cfg.keeper.liquidationConcurrency).toBe(5);
  });

  test('reads COMPOUND_CONCURRENCY as integer', () => {
    const cfg = loadConfig({ ...VALID_ENV, COMPOUND_CONCURRENCY: '8' });
    expect(cfg.keeper.compoundConcurrency).toBe(8);
  });

  test('reads JOB_MAX_ATTEMPTS as integer', () => {
    const cfg = loadConfig({ ...VALID_ENV, JOB_MAX_ATTEMPTS: '10' });
    expect(cfg.keeper.jobMaxAttempts).toBe(10);
  });

  test('throws on non-integer SCAN_INTERVAL_MS', () => {
    expect(() => loadConfig({ ...VALID_ENV, SCAN_INTERVAL_MS: 'fast' })).toThrow(
      'must be an integer',
    );
  });

  // ── Logging ───────────────────────────────────────────────────────────────────

  test('reads LOG_LEVEL from env', () => {
    const cfg = loadConfig({ ...VALID_ENV, LOG_LEVEL: 'debug' });
    expect(cfg.log.level).toBe('debug');
  });

  test('defaults LOG_LEVEL to "info"', () => {
    const cfg = loadConfig({ ...VALID_ENV, LOG_LEVEL: undefined });
    expect(cfg.log.level).toBe('info');
  });

  // ── Error Paths ───────────────────────────────────────────────────────────────

  test('requireEnv throws for missing mandatory variable', () => {
    // Missing VAULT_CONTRACT_ID and setting NODE_ENV away from 'test'
    // to bypass the test fallback return value.
    const incompleteEnv = { ...VALID_ENV, NODE_ENV: 'production' };
    delete (incompleteEnv as any).VAULT_CONTRACT_ID;

    expect(() => loadConfig(incompleteEnv)).toThrow(
      'Missing required environment variable: VAULT_CONTRACT_ID',
    );
  });
});
