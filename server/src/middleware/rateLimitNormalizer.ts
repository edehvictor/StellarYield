import { Request, Response, NextFunction } from 'express';
import { API_ERRORS } from '../types/apiErrorCatalog';

/**
 * Normalizes rate limit responses to conform to the standard API error catalog.
 * Useful for normalizing errors from express-rate-limit or similar middleware.
 */
export const rateLimitNormalizer = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (err.status === 429 || err.statusCode === 429 || err.type === 'RateLimitError') {
    return res.status(429).json({
      error: API_ERRORS.RATE_LIMITED.code,
      message: API_ERRORS.RATE_LIMITED.defaultMessage,
      retryCategory: API_ERRORS.RATE_LIMITED.retryCategory,
      details: err.message || 'You have exceeded the maximum number of allowed requests.'
    });
  }
  next(err);
};
