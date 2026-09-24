/**
 * resilience.ts
 * 
 * Resilience utilities for the Fragmentation Analyzer:
 *  - CircuitBreaker: prevents cascading failures when a data source is down.
 *  - fetchWithRetry: exponential backoff for transient failures.
 * 
 * Requirements: 7.3, 7.4 (graceful degradation + monitoring)
 */

/**
 * Thrown when a call is rejected because the circuit breaker is OPEN.
 */
export class CircuitBreakerOpenError extends Error {
  constructor(
    message: string,
    public readonly lastFailureAt: number | null = null
  ) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Circuit breaker state machine: CLOSED → OPEN → (HALF_OPEN) → CLOSED.
 *
 * - CLOSED:    calls pass through; consecutive failures are counted.
 * - OPEN:      calls fail fast until resetTimeoutMs elapses.
 * - HALF_OPEN: a single probe call decides whether to close or re-open.
 *
 * After `failureThreshold` consecutive failures the breaker opens. When the
 * reset timeout has elapsed, the next call is allowed through as a probe.
 * A successful probe closes the breaker; a failed probe re-opens it.
 */
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the breaker opens. Default: 5. */
  failureThreshold: number;
  /** How long the breaker stays OPEN before probing again. Default: 60 000 ms. */
  resetTimeoutMs: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
};

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_OPTIONS.failureThreshold;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_OPTIONS.resetTimeoutMs;
  }

  /**
   * Run `fn`, applying circuit breaker protection.
   *
   * When the breaker is OPEN and the reset timeout has not elapsed, throws a
   * `CircuitBreakerOpenError` without invoking `fn` (fail fast).
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (!this.shouldAttemptReset()) {
        throw new CircuitBreakerOpenError(
          'Circuit breaker is OPEN — failing fast without invoking the dependency',
          this.lastFailureTime
        );
      }
      // Allow one probe through to test whether the dependency recovered.
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Get the current breaker state.
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Get the current consecutive failure count.
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Manually reset the breaker to CLOSED.
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = null;
  }

  private shouldAttemptReset(): boolean {
    return (
      this.lastFailureTime !== null &&
      Date.now() - this.lastFailureTime > this.resetTimeoutMs
    );
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failureCount += 1;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}

/**
 * Sleep for the given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Invoke `fn`, retrying transient failures with exponential backoff.
 *
 * @param fn          - The async operation to run.
 * @param maxRetries  - Number of retries after the initial attempt. Default: 3.
 * @param baseDelayMs - Base backoff delay; delay for retry n is baseDelay * 2^n.
 * @returns The resolved value, or throws the last error once retries are exhausted.
 */
export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}