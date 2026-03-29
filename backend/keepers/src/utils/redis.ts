import { Redis } from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

let _redis: Redis | null = null;

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

    _redis.on('connect', () => logger.info('Redis connected'));
    _redis.on('error', (err) => logger.error({ err }, 'Redis connection error'));
  }
  return _redis;
}

/**
 * Close the shared Redis connection gracefully.
 * Called during process shutdown.
 */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
    logger.info('Redis connection closed');
  }
}

/** Exposed for testing — allows injecting a mock Redis instance */
export function _setRedisForTest(r: Redis): void {
  _redis = r;
}
