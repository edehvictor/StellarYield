/**
 * Shared cursor-based pagination contract for StellarYield list endpoints.
 *
 * ## Query parameters
 * - `cursor`  — opaque string token returned in a previous response's `nextCursor`.
 *              Pass `cursor=<value>` to fetch the next page.
 *              Omit (or pass an empty string) for the first page.
 * - `limit`   — number of items to return per page (default: 20, max: 100).
 *
 * ## Response shape
 * Every paginated endpoint returns `PaginatedResponse<T>`:
 *   {
 *     "data": [...],
 *     "pagination": {
 *       "nextCursor": "some-opaque-string" | null,
 *       "hasMore": true | false,
 *       "limit": 20
 *     }
 *   }
 *
 * A `nextCursor` of `null` means there are no more pages.
 * Clients should stop paginating when `hasMore === false`.
 */

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    /** Cursor to pass as `?cursor=` on the next request. `null` when no more pages. */
    nextCursor: string | null;
    /** `true` if another page exists after this one. */
    hasMore: boolean;
    /** Effective limit used for this page. */
    limit: number;
  };
}

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

/**
 * Parse and clamp `limit` from a query string value.
 * Returns `PAGINATION_DEFAULT_LIMIT` when the value is absent or invalid.
 */
export function parsePaginationLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return PAGINATION_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), PAGINATION_MAX_LIMIT);
}

// ── Stable timeline cursors (#1071) ─────────────────────────────────────────
//
// A cursor built from a single field (e.g. a row's `id`) is only stable if
// that field's natural order matches the query's sort order. For timeline
// feeds sorted by time (newest first), an id-only cursor (especially a
// random id like a UUID) has no relationship to that order — pagination
// can silently skip or duplicate rows whenever two rows share a timestamp,
// or whenever a new row is inserted between page requests.
//
// The fix: a cursor that encodes BOTH the sort key (`ts`, epoch ms) and a
// deterministic tie-breaker (`id`), matching a compound
// `ORDER BY ts DESC, id DESC` query. Rows are then paged with
// `(ts, id) < (cursor.ts, cursor.id)` in that same compound order, so a
// page boundary is always an exact, reproducible position in the sequence
// — independent of how many rows exist before or after it, and stable even
// if new rows are inserted mid-pagination (a new row can only ever land
// strictly after the already-issued cursor, in "ts DESC" order, so it never
// reshuffles a page that's already been paged past).

export interface TimelineCursor {
  /** Epoch ms of the sort key (e.g. `startedAt` / `timestamp`) for the last item on the previous page. */
  ts: number;
  /** Tie-breaker id for entries sharing the same `ts`; must be unique per entry. */
  id: string;
}

/** Encode a (ts, id) pair as an opaque pagination cursor. */
export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(`${cursor.ts}:${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor back into a (ts, id) pair.
 * Returns `null` for a missing, empty, or malformed cursor (callers should
 * treat `null` as "start from the first page" rather than erroring).
 */
export function decodeTimelineCursor(raw: string | undefined | null): TimelineCursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep === -1) return null;
    const ts = Number(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (!Number.isFinite(ts) || !id) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

/**
 * True when `key` sorts strictly after `cursor` in newest-first
 * (`ts DESC, id DESC`) order — i.e. `key` belongs on the next page.
 */
export function isBeforeTimelineCursor(key: TimelineCursor, cursor: TimelineCursor): boolean {
  if (key.ts !== cursor.ts) return key.ts < cursor.ts;
  return key.id < cursor.id;
}

/**
 * Compare two (ts, id) keys for newest-first (`ts DESC, id DESC`) order.
 * Returns <0 if `a` sorts before `b`, >0 if after, 0 if equal.
 */
export function compareTimelineKeysDesc(a: TimelineCursor, b: TimelineCursor): number {
  if (a.ts !== b.ts) return b.ts - a.ts;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
