import { NextFunction, Request, RequestHandler, Response } from "express";

export interface CacheControlOptions {
  /** How long a response may be served from cache before it is considered stale, in seconds. */
  maxAgeSeconds: number;
  /** How long a stale response may still be served while a fresh one is fetched in the background, in seconds. */
  staleWhileRevalidateSeconds?: number;
  /** Cache visibility. Defaults to "public" since these are non-personalized, read-only analytics responses. */
  scope?: "public" | "private";
}

/**
 * Builds middleware that attaches a `Cache-Control` header to read-only
 * JSON responses, so CDNs/browsers can cache analytics reads instead of
 * re-computing them on every request.
 *
 * The header is only applied to 2xx responses: error envelopes (validation
 * failures, internal errors) must never be cached, since retrying them
 * should re-hit the origin.
 */
export function cacheControl(options: CacheControlOptions): RequestHandler {
  const { maxAgeSeconds, staleWhileRevalidateSeconds, scope = "public" } = options;

  const directives = [scope, `max-age=${maxAgeSeconds}`];
  if (staleWhileRevalidateSeconds !== undefined) {
    directives.push(`stale-while-revalidate=${staleWhileRevalidateSeconds}`);
  }
  const headerValue = directives.join(", ");

  return (_req: Request, res: Response, next: NextFunction): void => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        res.setHeader("Cache-Control", headerValue);
      }
      return originalJson(body);
    }) as Response["json"];
    next();
  };
}
