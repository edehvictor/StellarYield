import { Redis } from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

let _redis: Redis | null = null;

/** Redis connection state for health checks (#1538). */
export type RedisConnectionState = 'connected' | 'reconnecting' | 'unavailable';

let _connectionState: RedisConnectionState = 'unavailable';
let _lastConnectedAt: string | null = null;
let _reconnectAttempts = 0;

/**
 * Returns a shared ioredis client.
 * The connection is lazy — it is only established on first call.
 *
 * @returns Shared Redis client instance
 */
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
      lazyConnect: true,
    });

    _redis.on('connect', () => {
      _connectionState = 'connected';
      _lastConnectedAt = new Date().toISOString();
      _reconnectAttempts = 0;
      logger.info('Redis connected');
    });
    _redis.on('ready', () => {
      _connectionState = 'connected';
    });
    _redis.on('reconnecting', () => {
      _connectionState = 'reconnecting';
      _reconnectAttempts++;
      logger.warn({ attempt: _reconnectAttempts }, 'Redis reconnecting');
    });
    _redis.on('error', (err) => {
      _connectionState = 'unavailable';
      logger.error({ err }, 'Redis connection error');
    });
    _redis.on('close', () => {
      _connectionState = 'unavailable';
    });
  }
  return _redis;
}

/**
 * Returns the current Redis connection state for health checks (#1538).
 * Distinguishes connected, reconnecting, and unavailable for job admission.
 */
export function getRedisConnectionState(): {
  state: RedisConnectionState;
  lastConnectedAt: string | null;
  reconnectAttempts: number;
} {
  return {
    state: _connectionState,
    lastConnectedAt: _lastConnectedAt,
    reconnectAttempts: _reconnectAttempts,
  };
}

/**
 * Returns true when Redis is available for job admission.
 */
export function isRedisAvailable(): boolean {
  return _connectionState === 'connected';
}

/**
 * Close the shared Redis connection gracefully.
 * Called during process shutdown.
 */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
    _connectionState = 'unavailable';
    logger.info('Redis connection closed');
  }
}

/** Exposed for testing — allows injecting a mock Redis instance */
export function _setRedisForTest(r: Redis): void {
  _redis = r;
}

/** Exposed for testing — allows resetting connection state */
export function _resetConnectionStateForTest(): void {
  _connectionState = 'unavailable';
  _lastConnectedAt = null;
  _reconnectAttempts = 0;
}
