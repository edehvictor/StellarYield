import pino from 'pino';
import { config } from '../config';

/**
 * Structured JSON logger backed by Pino.
 * Pretty-prints in development, raw JSON in production for log aggregators.
 */
export const logger = pino({
  level: config.log.level,
  transport:
    process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  base: { service: 'stellar-yield-keepers' },
});
