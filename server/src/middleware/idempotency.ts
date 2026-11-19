/**
 * Idempotency keys for money-moving requests (deposits and withdrawals).
 *
 * A client that times out or loses its connection cannot tell whether the
 * server acted, so it retries — and without a key a retry creates a second
 * withdrawal or deposit intent. With an `Idempotency-Key` header:
 *
 *   first request            → runs the handler; a 2xx/4xx result is stored
 *   retry, same key + body   → stored status/body replayed, handler not re-run
 *                              (`Idempotent-Replayed: true`)
 *   retry while first runs   → 409 IDEMPOTENCY_REQUEST_IN_PROGRESS (Retry-After)
 *   same key, different body → 422 IDEMPOTENCY_KEY_REUSED
 *   malformed key            → 400 INVALID_IDEMPOTENCY_KEY
 *   store unreachable        → 503 IDEMPOTENCY_STORE_UNAVAILABLE (fail closed:
 *                              never risk a duplicate money movement)
 *
 * 5xx responses and requests that end without a response are *not* stored —
 * the reservation is released so the client can retry with the same key.
 *
 * The header is optional unless `IDEMPOTENCY_REQUIRED=true` (then a missing
 * key is 400 IDEMPOTENCY_KEY_REQUIRED), so existing clients keep working.
 *
 * | Variable              | Default  | Meaning                                  |
 * | --------------------- | -------- | ---------------------------------------- |
 * | `IDEMPOTENCY_STORE`   | `memory` | `memory` (single instance) or `redis`    |
 * | `IDEMPOTENCY_TTL_MS`  | 86400000 | How long a key and its result are kept   |
 * | `IDEMPOTENCY_REQUIRED`| `false`  | Reject money-moving requests without key |
 */

import { createHash, randomUUID } from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { sendError } from "../utils/errorResponse";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** 1–255 URL-safe characters; UUIDs and ULIDs both fit. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/;

export type IdempotencyErrorCode =
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "INVALID_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_REQUEST_IN_PROGRESS"
  | "IDEMPOTENCY_STORE_UNAVAILABLE";

// ── Store ─────────────────────────────────────────────────────────────────────

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type IdempotencyRecord =
  | { state: "in_progress"; fingerprint: string; token: string }
  | { state: "completed"; fingerprint: string; response: StoredResponse };

export type ReserveResult =
  | { reserved: true; token: string }
  | { reserved: false; existing: IdempotencyRecord };

/**
 * Backing store. `reserve` must be atomic: of two concurrent callers with the
 * same key, exactly one gets `reserved: true`.
 */
export interface IdempotencyStore {
  reserve(key: string, fingerprint: string, ttlMs: number): Promise<ReserveResult>;
  complete(key: string, token: string, fingerprint: string, response: StoredResponse, ttlMs: number): Promise<void>;
  release(key: string, token: string): Promise<void>;
}

/** Single-process store. Bounded; expired entries are purged lazily. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async reserve(key: string, fingerprint: string, ttlMs: number): Promise<ReserveResult> {
    const current = this.entries.get(key);
    if (current && current.expiresAt > this.now()) {
      return { reserved: false, existing: current.record };
    }
    this.entries.delete(key);
    this.evict();
    const token = randomUUID();
    this.entries.set(key, {
      record: { state: "in_progress", fingerprint, token },
      expiresAt: this.now() + ttlMs,
    });
    return { reserved: true, token };
  }

  async complete(
    key: string,
    token: string,
    fingerprint: string,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<void> {
    const current = this.entries.get(key);
    if (current?.record.state !== "in_progress" || current.record.token !== token) return;
    this.entries.set(key, {
      record: { state: "completed", fingerprint, response },
      expiresAt: this.now() + ttlMs,
    });
  }

  async release(key: string, token: string): Promise<void> {
    const current = this.entries.get(key);
    if (current?.record.state === "in_progress" && current.record.token === token) {
      this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // Map iteration is insertion order, so this drops the oldest keys first.
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}

/** The subset of the ioredis client this store uses. */
export interface RedisLike {
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<"OK" | null>;
  set(key: string, value: string, px: "PX", ttl: number): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

/**
 * Shared store for multi-instance deployments. Reservation is a single
 * `SET NX PX`, so it is atomic across instances.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = "idempotency:",
  ) {}

  async reserve(key: string, fingerprint: string, ttlMs: number): Promise<ReserveResult> {
    const token = randomUUID();
    const record: IdempotencyRecord = { state: "in_progress", fingerprint, token };
    const ok = await this.redis.set(this.prefix + key, JSON.stringify(record), "PX", ttlMs, "NX");
    if (ok === "OK") return { reserved: true, token };

    const raw = await this.redis.get(this.prefix + key);
    if (raw === null) {
      // Expired between SET and GET — try once more.
      const retry = await this.redis.set(this.prefix + key, JSON.stringify(record), "PX", ttlMs, "NX");
      if (retry === "OK") return { reserved: true, token };
      const again = await this.redis.get(this.prefix + key);
      if (again === null) throw new Error("idempotency record vanished during reservation");
      return { reserved: false, existing: JSON.parse(again) as IdempotencyRecord };
    }
    return { reserved: false, existing: JSON.parse(raw) as IdempotencyRecord };
  }

  async complete(
    key: string,
    token: string,
    fingerprint: string,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<void> {
    if (!(await this.owns(key, token))) return;
    const record: IdempotencyRecord = { state: "completed", fingerprint, response };
    await this.redis.set(this.prefix + key, JSON.stringify(record), "PX", ttlMs);
  }

  async release(key: string, token: string): Promise<void> {
    // Check-then-delete: the window only matters if our reservation expired
    // (after a full TTL) and was re-reserved in between, which the TTL rules out
    // for any request that finishes in a sane time.
    if (await this.owns(key, token)) await this.redis.del(this.prefix + key);
  }

  private async owns(key: string, token: string): Promise<boolean> {
    const raw = await this.redis.get(this.prefix + key);
    if (raw === null) return false;
    const record = JSON.parse(raw) as IdempotencyRecord;
    return record.state === "in_progress" && record.token === token;
  }
}

// ── Fingerprint ───────────────────────────────────────────────────────────────

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` fingerprint the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

export function requestFingerprint(req: Request): string {
  return createHash("sha256")
    .update(`${req.method}\n${req.baseUrl}${req.path}\n${canonicalJson(req.body ?? null)}`)
    .digest("hex");
}

// ── Middleware ────────────────────────────────────────────────────────────────

export interface IdempotencyOptions {
  /** Namespaces keys so one key can't collide across endpoints. */
  scope: string;
  store?: IdempotencyStore;
  ttlMs?: number;
  /** Reject requests without a key. Defaults to `IDEMPOTENCY_REQUIRED === "true"`. */
  required?: boolean;
}

function readTtl(env: NodeJS.ProcessEnv): number {
  const n = Number(env.IDEMPOTENCY_TTL_MS);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_IDEMPOTENCY_TTL_MS;
}

let defaultStore: IdempotencyStore | null = null;

/**
 * Process-wide store from `IDEMPOTENCY_STORE`. Redis is connected lazily so
 * importing this module never opens a socket.
 */
export function getDefaultIdempotencyStore(env: NodeJS.ProcessEnv = process.env): IdempotencyStore {
  if (defaultStore) return defaultStore;
  if (env.IDEMPOTENCY_STORE === "redis") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Redis } = require("ioredis") as typeof import("ioredis");
    const client = new Redis(env.REDIS_URL || "redis://localhost:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
    });
    defaultStore = new RedisIdempotencyStore(client as unknown as RedisLike);
  } else {
    defaultStore = new InMemoryIdempotencyStore();
  }
  return defaultStore;
}

/** Test hook: swap or reset the process-wide store. */
export function setDefaultIdempotencyStore(store: IdempotencyStore | null): void {
  defaultStore = store;
}

export function idempotency(options: IdempotencyOptions): RequestHandler {
  const ttlMs = options.ttlMs ?? readTtl(process.env);

  return async (req: Request, res: Response, next: NextFunction) => {
    const store = options.store ?? getDefaultIdempotencyStore();
    const required = options.required ?? process.env.IDEMPOTENCY_REQUIRED === "true";
    const header = req.get(IDEMPOTENCY_HEADER);

    if (header === undefined) {
      if (required) {
        return sendError(
          res,
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          `This endpoint requires an \`${IDEMPOTENCY_HEADER}\` header.`,
        );
      }
      return next();
    }

    if (!KEY_PATTERN.test(header)) {
      return sendError(
        res,
        400,
        "INVALID_IDEMPOTENCY_KEY",
        `\`${IDEMPOTENCY_HEADER}\` must be 1–255 characters of A–Z, a–z, 0–9, '.', '_', ':' or '-'.`,
      );
    }

    const key = `${options.scope}:${header}`;
    const fingerprint = requestFingerprint(req);

    let reservation: ReserveResult;
    try {
      reservation = await store.reserve(key, fingerprint, ttlMs);
    } catch {
      return sendError(
        res,
        503,
        "IDEMPOTENCY_STORE_UNAVAILABLE",
        "Request could not be safely de-duplicated right now; retry with the same key.",
        undefined,
        undefined,
        true,
      );
    }

    if (!reservation.reserved) {
      const { existing } = reservation;
      if (existing.fingerprint !== fingerprint) {
        return sendError(
          res,
          422,
          "IDEMPOTENCY_KEY_REUSED",
          `This \`${IDEMPOTENCY_HEADER}\` was already used with a different request body.`,
        );
      }
      if (existing.state === "in_progress") {
        res.set("Retry-After", "1");
        return sendError(
          res,
          409,
          "IDEMPOTENCY_REQUEST_IN_PROGRESS",
          "A request with this key is still being processed.",
          undefined,
          undefined,
          true,
        );
      }
      res.set(IDEMPOTENT_REPLAYED_HEADER, "true");
      return res.status(existing.response.status).json(existing.response.body);
    }

    const { token } = reservation;
    let captured: { body: unknown } | null = null;
    let settled = false;

    const originalJson = res.json.bind(res);
    res.json = (body?: unknown) => {
      captured = { body };
      return originalJson(body);
    };

    const settle = (finished: boolean) => {
      if (settled) return;
      settled = true;
      const status = res.statusCode;
      const done =
        finished && captured !== null && status < 500
          ? store.complete(key, token, fingerprint, { status, body: captured.body }, ttlMs)
          : store.release(key, token);
      done.catch((err) => {
        console.error("[idempotency] failed to settle key", options.scope, err);
      });
    };

    res.on("finish", () => settle(true));
    res.on("close", () => settle(res.writableFinished));

    try {
      next();
    } catch (err) {
      settle(false);
      throw err;
    }
  };
}
