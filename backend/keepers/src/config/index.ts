import dotenv from 'dotenv';

dotenv.config();

/**
 * Typed, validated configuration for the Keeper service.
 * All values are read from environment variables; missing required values
 * will cause the process to exit immediately to fail fast in misconfigured
 * deployments.
 */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    if (process.env.NODE_ENV === 'test') {
      return `MOCK_${key}`;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function optionalInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Environment variable ${key} must be an integer, got "${raw}"`);
  return n;
}

export const config = {
  stellar: {
    network: optionalEnv('STELLAR_NETWORK', 'testnet') as 'testnet' | 'mainnet',
    horizonUrl: optionalEnv(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    ),
    sorobanRpcUrl: optionalEnv(
      'STELLAR_SOROBAN_RPC_URL',
      'https://soroban-testnet.stellar.org',
    ),
    /** Keeper bot secret key — pulled from env or KMS in production */
    keeperSecretKey: optionalEnv('KEEPER_SECRET_KEY', ''),
    baseFee: optionalInt('BASE_FEE', 100),
  },
  contracts: {
    vault: requireEnv('VAULT_CONTRACT_ID'),
    stablecoinManager: requireEnv('STABLECOIN_MANAGER_CONTRACT_ID'),
  },
  redis: {
    url: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
  },
  keeper: {
    scanIntervalMs: optionalInt('SCAN_INTERVAL_MS', 30_000),
    mcrBps: optionalInt('MCR_BPS', 11_000),
    liquidationConcurrency: optionalInt('LIQUIDATION_CONCURRENCY', 3),
    compoundConcurrency: optionalInt('COMPOUND_CONCURRENCY', 5),
    jobMaxAttempts: optionalInt('JOB_MAX_ATTEMPTS', 5),
    /** Comma-separated list of account addresses to manually monitor if no indexer is used */
    monitoredAddresses: optionalEnv('MONITORED_ADDRESSES', '').split(',').filter(Boolean),
  },
  log: {
    level: optionalEnv('LOG_LEVEL', 'info'),
  },
} as const;

export type Config = typeof config;
