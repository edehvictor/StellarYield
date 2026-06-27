export interface ResilientFetchOptions {
  timeoutMs: number;
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const DEFAULTS: ResilientFetchOptions = {
  timeoutMs: 15_000,
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
};

export interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  isOpen: boolean;
}

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 60_000;

const circuitBreakers = new Map<string, CircuitBreakerState>();

export function getCircuitBreaker(key: string): CircuitBreakerState {
  if (!circuitBreakers.has(key)) {
    circuitBreakers.set(key, { failures: 0, lastFailureTime: 0, isOpen: false });
  }
  return circuitBreakers.get(key)!;
}

export function resetCircuitBreaker(key: string): void {
  circuitBreakers.set(key, { failures: 0, lastFailureTime: 0, isOpen: false });
}

export function resetAllCircuitBreakers(): void {
  circuitBreakers.clear();
}

function checkCircuitBreaker(key: string): void {
  const cb = getCircuitBreaker(key);

  if (cb.isOpen) {
    const elapsed = Date.now() - cb.lastFailureTime;
    if (elapsed >= CIRCUIT_BREAKER_RESET_MS) {
      cb.isOpen = false;
      cb.failures = 0;
    } else {
      throw new Error(
        `Circuit breaker open for "${key}": ${cb.failures} consecutive failures. Resets in ${Math.ceil((CIRCUIT_BREAKER_RESET_MS - elapsed) / 1000)}s.`,
      );
    }
  }
}

function recordSuccess(key: string): void {
  const cb = getCircuitBreaker(key);
  cb.failures = 0;
  cb.isOpen = false;
}

function recordFailure(key: string): void {
  const cb = getCircuitBreaker(key);
  cb.failures++;
  cb.lastFailureTime = Date.now();
  if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    cb.isOpen = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("aborted") ||
      msg.includes("network") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("server error")
    );
  }
  return false;
}

export async function resilientFetch(
  url: string,
  init: RequestInit,
  circuitKey: string,
  opts: Partial<ResilientFetchOptions> = {},
): Promise<Response> {
  const options = { ...DEFAULTS, ...opts };

  checkCircuitBreaker(circuitKey);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);

      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status >= 500) {
        throw new Error(`Server error: ${response.status}`);
      }

      recordSuccess(circuitKey);
      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < options.maxRetries && isRetryable(lastError)) {
        const delay = Math.min(
          options.initialDelayMs * Math.pow(2, attempt),
          options.maxDelayMs,
        );
        await sleep(delay);
        continue;
      }

      break;
    }
  }

  recordFailure(circuitKey);
  throw lastError ?? new Error("resilientFetch failed");
}

export { CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_RESET_MS };
