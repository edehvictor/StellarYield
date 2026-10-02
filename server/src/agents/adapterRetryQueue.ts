/**
 * Adapter Retry Queue with Rate Limiting
 *
 * Wraps outbound protocol-adapter calls (Soroban RPC, Horizon, Gemini,
 * Pinata, etc.) with:
 *
 *  1. Per-provider token-bucket rate limiting — prevents burst-flooding a
 *     provider and respects documented or conservative per-second caps.
 *  2. Exponential-backoff retry on transient/rate-limit failures — 429
 *     responses are treated as retryable (they were not in resilientFetch).
 *  3. Typed, stable errors — exhausted retries always surface
 *     `AdapterRequestFailedError` rather than raw provider output.
 *  4. No silent drops — every enqueued request either resolves, retries up
 *     to the configured maximum, or rejects with a typed error.
 *
 * ## Rate limiting strategy
 *
 * A token-bucket approach was chosen because:
 *   - It is the simplest model that handles both "burst then slow" and
 *     "steady trickle" access patterns.
 *   - It matches how most RPC providers document their limits (req/s or
 *     req/minute averaged as req/s).
 *   - It can be implemented with a single counter and timestamp — no
 *     external dependency, consistent with every other queue here.
 *
 * Default limit: 10 req/s per provider (conservative; the Stellar Foundation's
 * public testnet RPC is documented at ~10–30 req/s; Horizon at ~100 req/s;
 * LLM APIs at 15–60 req/min).  Override globally with the env var
 * `ADAPTER_RATE_LIMIT_RPS` or per-provider with
 * `ADAPTER_RATE_LIMIT_RPS_<PROVIDER_KEY>` where <PROVIDER_KEY> is the
 * circuit-breaker key uppercased with hyphens replaced by underscores.
 *
 * ## Retry strategy
 *
 * Exponential backoff with jitter matching `resilientFetch`:
 *   delay = min(initialDelayMs * 2^attempt, maxDelayMs) + jitter(0..200ms)
 *
 * 429 Too Many Requests responses are retried with a longer initial delay
 * (respects the spirit of the rate-limit signal from the provider).
 *
 * ## Concurrency
 *
 * The queue drains requests sequentially per provider key by design.  This
 * is the safest model given the rate-limit concern — parallel in-flight
 * requests to the same provider can cause burst problems.  Requests to
 * different providers run concurrently (each has its own queue).
 */

import { recordFailure, resolveNetworkLabel } from "../monitoring/prometheus";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Options passed to `enqueueAdapterRequest`. */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts after the initial attempt.
   * Total calls = maxRetries + 1.
   * Default: ADAPTER_MAX_RETRIES env var, or 3.
   */
  maxRetries?: number;
  /**
   * Initial backoff delay in ms before the first retry.
   * Default: 500 ms.
   */
  initialDelayMs?: number;
  /**
   * Maximum backoff delay in ms (caps the exponential growth).
   * Default: 8_000 ms.
   */
  maxDelayMs?: number;
  /**
   * Jitter ceiling in ms added to each computed delay to spread retries.
   * Default: 200 ms.
   */
  maxJitterMs?: number;
  /**
   * Per-request timeout in ms.  Set to 0 to disable.
   * Default: 0 (no per-request timeout from this layer — callers apply
   * their own via AbortController / Promise.race as they already do).
   */
  timeoutMs?: number;
}

/** Typed error returned when all retry attempts are exhausted. */
export class AdapterRequestFailedError extends Error {
  /** Stable machine-readable code, safe to branch on in consumers. */
  readonly code: "ADAPTER_EXHAUSTED" | "ADAPTER_RATE_LIMITED" | "ADAPTER_TIMEOUT";
  /** The original error from the last attempt. */
  readonly cause: Error;
  /** Number of attempts made (initial + retries). */
  readonly attempts: number;
  /** Provider/circuit-breaker key that failed. */
  readonly provider: string;

  constructor(opts: {
    code: AdapterRequestFailedError["code"];
    message: string;
    cause: Error;
    attempts: number;
    provider: string;
  }) {
    super(opts.message);
    this.name = "AdapterRequestFailedError";
    this.code = opts.code;
    this.cause = opts.cause;
    this.attempts = opts.attempts;
    this.provider = opts.provider;
  }
}

/** Snapshot of a provider queue's internal state (useful for health checks). */
export interface ProviderQueueStatus {
  provider: string;
  /** Requests currently waiting behind the rate-limit gate. */
  pendingCount: number;
  /** Token bucket: current tokens available (0 to rps). */
  availableTokens: number;
  /** Configured rate limit (req/s). */
  rps: number;
  /** Latest attempt outcome for this provider. */
  lastOutcome?: "success" | "retrying" | "exhausted";
}

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_RPS = 10;
const DEFAULT_MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
const MAX_JITTER_MS = 200;
/**
 * When a provider returns 429 we use a longer initial delay because they
 * are explicitly signalling "back off".
 */
const RATE_LIMIT_429_INITIAL_DELAY_MS = 2_000;

function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolves the effective RPS for a given provider key.
 * Checks `ADAPTER_RATE_LIMIT_RPS_<PROVIDER_KEY_UPPER>` first, then
 * `ADAPTER_RATE_LIMIT_RPS`, then falls back to `DEFAULT_RPS`.
 */
function resolveRps(providerKey: string): number {
  const envSuffix = providerKey.toUpperCase().replace(/-/g, "_");
  const perProvider = parseEnvInt(`ADAPTER_RATE_LIMIT_RPS_${envSuffix}`, 0);
  if (perProvider > 0) return perProvider;
  return parseEnvInt("ADAPTER_RATE_LIMIT_RPS", DEFAULT_RPS);
}

// ── Token Bucket ──────────────────────────────────────────────────────────────

/**
 * Simple token-bucket rate limiter.
 *
 * A bucket holds up to `rps` tokens (one per slot in the current second).
 * Each consumed token represents one outbound request being allowed.
 * Tokens refill continuously based on elapsed time.
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly rps: number) {
    this.tokens = rps;
    this.lastRefillMs = Date.now();
  }

  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Attempt to consume one token. Returns true immediately if a token is
   * available; otherwise the caller must wait for `delayUntilNextToken()`
   * milliseconds.
   */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** How many ms until the next token becomes available. */
  delayUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    // Time to accumulate the fractional deficit back to 1 token
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.rps) * 1000);
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.rps, this.tokens + elapsedSec * this.rps);
    this.lastRefillMs = now;
  }
}

// ── Provider Queue ────────────────────────────────────────────────────────────

/**
 * Per-provider queue state.
 *
 * Requests are serialised through a promise chain so at most one is
 * executing (or waiting on the rate limit) at a time per provider.
 */
interface ProviderQueue {
  bucket: TokenBucket;
  /** Promise chain ensuring sequential execution. */
  tail: Promise<void>;
  pendingCount: number;
  lastOutcome?: "success" | "retrying" | "exhausted";
}

const queues = new Map<string, ProviderQueue>();

function getProviderQueue(providerKey: string): ProviderQueue {
  if (!queues.has(providerKey)) {
    const rps = resolveRps(providerKey);
    queues.set(providerKey, {
      bucket: new TokenBucket(rps),
      tail: Promise.resolve(),
      pendingCount: 0,
      lastOutcome: undefined,
    });
  }
  return queues.get(providerKey)!;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compute jittered exponential delay. */
function computeDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  maxJitterMs: number,
): number {
  const exp = initialDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exp, maxDelayMs);
  const jitter = Math.random() * maxJitterMs;
  return Math.round(capped + jitter);
}

/**
 * Classify whether an error is retryable and whether it was a 429.
 */
function classifyError(err: unknown): {
  retryable: boolean;
  isRateLimit: boolean;
} {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Explicit 429 / rate-limit signals
    if (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("rate_limit") ||
      msg.includes("too many requests") ||
      msg.includes("ratelimit")
    ) {
      return { retryable: true, isRateLimit: true };
    }
    // Transient server / network errors (mirrors resilientFetch logic + adds 503)
    if (
      msg.includes("timeout") ||
      msg.includes("aborted") ||
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("server error") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504")
    ) {
      return { retryable: true, isRateLimit: false };
    }
  }
  return { retryable: false, isRateLimit: false };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enqueue a protocol-adapter request with automatic rate limiting and retry.
 *
 * @param fn           — Zero-arg async function that performs the outbound
 *                       call and returns the result.  Called once per attempt.
 * @param providerKey  — Stable string identifying the provider (matches the
 *                       `circuitKey` used in `resilientFetch`).  Controls
 *                       which rate-limit bucket and queue the request joins.
 * @param opts         — Optional override for retry/backoff parameters.
 *
 * @returns            Resolved value from `fn` on success.
 *
 * @throws `AdapterRequestFailedError` when all attempts are exhausted, with:
 *   - `.code` = "ADAPTER_EXHAUSTED" | "ADAPTER_RATE_LIMITED" | "ADAPTER_TIMEOUT"
 *   - `.cause` = the original error from the last attempt
 *   - `.attempts` = total calls made
 *   - `.provider` = the providerKey
 *
 * ## Behaviour invariants
 *
 * - Never silently drops a request — every call either resolves or rejects.
 * - Never fires a request when the rate-limit bucket is empty — waits for
 *   the next token and then proceeds.
 * - Does not retry non-transient errors (4xx except 429, auth failures, etc.)
 *   to avoid hammering providers with bad requests.
 * - Requests to different providers execute concurrently (each has its own
 *   queue and bucket).
 */
export async function enqueueAdapterRequest<T>(
  fn: () => Promise<T>,
  providerKey: string,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? parseEnvInt("ADAPTER_MAX_RETRIES", DEFAULT_MAX_RETRIES);
  const initialDelayMs = opts.initialDelayMs ?? INITIAL_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS;
  const maxJitterMs = opts.maxJitterMs ?? MAX_JITTER_MS;

  const queue = getProviderQueue(providerKey);
  queue.pendingCount++;

  // Serialise execution behind the current tail promise for this provider.
  let resolveSlot!: () => void;
  const slot = new Promise<void>((res) => {
    resolveSlot = res;
  });

  const previousTail = queue.tail;
  queue.tail = previousTail.then(() => slot);

  try {
    // Wait for our turn in the queue.
    await previousTail;

    return await executeWithRetry<T>(
      fn,
      providerKey,
      queue,
      maxRetries,
      initialDelayMs,
      maxDelayMs,
      maxJitterMs,
    );
  } finally {
    queue.pendingCount = Math.max(0, queue.pendingCount - 1);
    resolveSlot();
  }
}

async function executeWithRetry<T>(
  fn: () => Promise<T>,
  providerKey: string,
  queue: ProviderQueue,
  maxRetries: number,
  initialDelayMs: number,
  maxDelayMs: number,
  maxJitterMs: number,
): Promise<T> {
  let lastError: Error = new Error("Unknown error");
  let isRateLimitFailure = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // ── Rate-limit gate ────────────────────────────────────────────
    // Wait until a token is available before firing the request.
    // In the common (non-burst) path, tryConsume() returns true immediately.
    while (!queue.bucket.tryConsume()) {
      const waitMs = queue.bucket.delayUntilNextToken();
      await sleep(waitMs);
    }

    // ── Execute ────────────────────────────────────────────────────
    if (attempt > 0) {
      queue.lastOutcome = "retrying";
    }

    try {
      const result = await fn();
      queue.lastOutcome = "success";
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const { retryable, isRateLimit } = classifyError(lastError);
      isRateLimitFailure = isRateLimitFailure || isRateLimit;

      if (!retryable || attempt >= maxRetries) {
        // Non-retryable or out of attempts — fall through to the throw below.
        break;
      }

      // ── Backoff ────────────────────────────────────────────────
      // Use a longer initial delay for 429s to respect the provider's signal.
      const baseDelay = isRateLimit ? RATE_LIMIT_429_INITIAL_DELAY_MS : initialDelayMs;
      const delay = computeDelay(attempt, baseDelay, maxDelayMs, maxJitterMs);

      console.warn(
        `[AdapterRetryQueue] provider="${providerKey}" attempt=${attempt + 1}/${maxRetries + 1} ` +
          `retryable=true isRateLimit=${isRateLimit} backoffMs=${delay} error="${lastError.message}"`,
      );

      await sleep(delay);
    }
  }

  // All attempts exhausted.
  const attempts = maxRetries + 1;
  queue.lastOutcome = "exhausted";

  recordFailure({
    provider: providerKey,
    network: resolveNetworkLabel(),
    route: "adapter_retry_queue",
    failure_category: isRateLimitFailure ? "rate_limited" : "exhausted",
  });

  const code: AdapterRequestFailedError["code"] = isRateLimitFailure
    ? "ADAPTER_RATE_LIMITED"
    : "ADAPTER_EXHAUSTED";

  const message =
    `[AdapterRetryQueue] provider="${providerKey}" all ${attempts} attempt(s) failed ` +
    `(code=${code}): ${lastError.message}`;

  console.error(message);

  throw new AdapterRequestFailedError({
    code,
    message,
    cause: lastError,
    attempts,
    provider: providerKey,
  });
}

// ── Observability ─────────────────────────────────────────────────────────────

/**
 * Snapshot the current state of all provider queues.
 * Useful for health-check and admin endpoints.
 */
export function getAllProviderQueueStatuses(): ProviderQueueStatus[] {
  const result: ProviderQueueStatus[] = [];
  for (const [provider, queue] of queues.entries()) {
    result.push({
      provider,
      pendingCount: queue.pendingCount,
      availableTokens: queue.bucket.availableTokens,
      rps: resolveRps(provider),
      lastOutcome: queue.lastOutcome,
    });
  }
  return result;
}

/**
 * Return the queue status for a single provider.
 * Returns `undefined` if the provider has never been used.
 */
export function getProviderQueueStatus(providerKey: string): ProviderQueueStatus | undefined {
  const queue = queues.get(providerKey);
  if (!queue) return undefined;
  return {
    provider: providerKey,
    pendingCount: queue.pendingCount,
    availableTokens: queue.bucket.availableTokens,
    rps: resolveRps(providerKey),
    lastOutcome: queue.lastOutcome,
  };
}

/**
 * Reset all provider queues and their token buckets.
 * Intended for use in tests only.
 */
export function resetAllProviderQueues(): void {
  queues.clear();
}
