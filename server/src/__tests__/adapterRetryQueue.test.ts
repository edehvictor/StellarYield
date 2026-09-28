/**
 * adapterRetryQueue.test.ts
 *
 * Smoke tests + edge-case coverage for the adapter retry queue.
 *
 * Tests:
 *  1. Main path  — request fails once, succeeds on retry
 *  2. Edge case A — exhausts all retries → typed AdapterRequestFailedError
 *  3. Edge case B — rate limiting actually caps throughput (N+1 burst is delayed)
 *  4. Edge case C — concurrent requests to DIFFERENT providers don't block each other
 *  5. Edge case D — non-retryable error is NOT retried
 *  6. Edge case E — 429 response is treated as retryable (unlike plain 4xx)
 *  7. Edge case F — queue idle (empty) state is not confused with a failure
 *  8. Edge case G — burst of requests through a single provider respects order
 *  9. 429 in resilientFetch — patched to retry on 429 responses
 */

import {
  enqueueAdapterRequest,
  AdapterRequestFailedError,
  resetAllProviderQueues,
  getProviderQueueStatus,
  getAllProviderQueueStatuses,
} from "../agents/adapterRetryQueue";

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetAllProviderQueues();
  jest.useFakeTimers({ advanceTimers: true });
});

afterEach(() => {
  jest.useRealTimers();
  resetAllProviderQueues();
});

// ── Helper ────────────────────────────────────────────────────────────────────

/** Make a fn that fails `failTimes` times then succeeds. */
function makeFlaky(failTimes: number, successValue: string = "ok") {
  let calls = 0;
  return jest.fn(async () => {
    calls++;
    if (calls <= failTimes) throw new Error(`server error ${calls}`);
    return successValue;
  });
}

// ── 1. Main path — fail once, succeed on retry ────────────────────────────────

test("1. succeeds on second attempt after one transient failure", async () => {
  const fn = makeFlaky(1, "result-a");

  const result = await enqueueAdapterRequest(fn, "test-provider-1", {
    maxRetries: 2,
    initialDelayMs: 10,
    maxDelayMs: 50,
  });

  expect(result).toBe("result-a");
  expect(fn).toHaveBeenCalledTimes(2);
});

// ── 2. Edge case A — exhausts all retries → typed error ──────────────────────

test("2. exhausts retries and throws AdapterRequestFailedError with correct shape", async () => {
  const fn = jest.fn().mockRejectedValue(new Error("server error"));

  const err = await enqueueAdapterRequest(fn, "test-provider-2", {
    maxRetries: 2,
    initialDelayMs: 10,
    maxDelayMs: 50,
  }).catch((e) => e);

  // Must be the typed error — not a raw provider error string
  expect(err).toBeInstanceOf(AdapterRequestFailedError);
  expect(err.code).toBe("ADAPTER_EXHAUSTED");
  expect(err.provider).toBe("test-provider-2");
  expect(err.attempts).toBe(3); // initial + 2 retries
  expect(err.cause).toBeInstanceOf(Error);
  expect(err.cause.message).toContain("server error");
  // Must not expose raw provider HTTP body or internal stacktrace fragments
  // directly as the top-level message — only the stable wrapper message.
  expect(err.message).toContain("ADAPTER_EXHAUSTED");
  expect(fn).toHaveBeenCalledTimes(3);
});

// ── 3. Edge case B — rate limiting delays burst ───────────────────────────────

test("3. rate limiting enforces delay between requests when bucket is exhausted", async () => {
  // Set RPS to 1 via env so the bucket holds only 1 token.
  process.env.ADAPTER_RATE_LIMIT_RPS_BURST_PROVIDER = "1";

  try {
    const callTimes: number[] = [];
    const fn = jest.fn(async () => {
      callTimes.push(Date.now());
      return "ok";
    });

    // Fire 3 requests through the queue sequentially (same provider = serialised).
    // With 1 RPS, the 2nd and 3rd requests must wait ~1000 ms each.
    const p1 = enqueueAdapterRequest(fn, "burst-provider", { maxRetries: 0 });
    const p2 = enqueueAdapterRequest(fn, "burst-provider", { maxRetries: 0 });
    const p3 = enqueueAdapterRequest(fn, "burst-provider", { maxRetries: 0 });

    // Advance fake timers enough to drain the queue (3 × 1s + buffer)
    jest.advanceTimersByTime(5000);

    await Promise.all([p1, p2, p3]);

    // All 3 must eventually complete
    expect(fn).toHaveBeenCalledTimes(3);

    // With 1 RPS, the gaps between consecutive calls must be ≥ ~900 ms
    // (small tolerance for timer granularity in fake timers)
    if (callTimes.length === 3) {
      const gap1 = callTimes[1]! - callTimes[0]!;
      const gap2 = callTimes[2]! - callTimes[1]!;
      expect(gap1).toBeGreaterThanOrEqual(900);
      expect(gap2).toBeGreaterThanOrEqual(900);
    }
  } finally {
    delete process.env.ADAPTER_RATE_LIMIT_RPS_BURST_PROVIDER;
  }
});

// ── 4. Edge case C — different providers don't block each other ───────────────

test("4. concurrent requests to different providers execute independently", async () => {
  const completionOrder: string[] = [];

  // provider-alpha resolves after 100 ms
  const alphaFn = jest.fn(async () => {
    await new Promise<void>((r) => setTimeout(r, 100));
    completionOrder.push("alpha");
    return "alpha";
  });

  // provider-beta resolves after 20 ms — much faster
  const betaFn = jest.fn(async () => {
    await new Promise<void>((r) => setTimeout(r, 20));
    completionOrder.push("beta");
    return "beta";
  });

  // Advance timers to let both resolve
  const [resAlpha, resBeta] = await Promise.all([
    enqueueAdapterRequest(alphaFn, "provider-alpha", { maxRetries: 0 }),
    enqueueAdapterRequest(betaFn, "provider-beta", { maxRetries: 0 }),
  ]);

  expect(resAlpha).toBe("alpha");
  expect(resBeta).toBe("beta");

  // beta resolves faster — it should appear first in completionOrder
  expect(completionOrder[0]).toBe("beta");
  expect(completionOrder[1]).toBe("alpha");
});

// ── 5. Edge case D — non-retryable error is not retried ──────────────────────

test("5. non-retryable error (e.g. auth failure) is NOT retried", async () => {
  const fn = jest.fn().mockRejectedValue(new Error("Unauthorized: invalid API key"));

  const err = await enqueueAdapterRequest(fn, "test-provider-5", {
    maxRetries: 3,
    initialDelayMs: 10,
  }).catch((e) => e);

  expect(err).toBeInstanceOf(AdapterRequestFailedError);
  // Only the initial attempt — no retries for non-retryable errors
  expect(fn).toHaveBeenCalledTimes(1);
});

// ── 6. Edge case E — 429 is treated as retryable ─────────────────────────────

test("6. 429 Too Many Requests error is retried and surfaces as ADAPTER_RATE_LIMITED when exhausted", async () => {
  const fn = jest.fn().mockRejectedValue(new Error("429 Too Many Requests"));

  const err = await enqueueAdapterRequest(fn, "test-provider-6", {
    maxRetries: 2,
    initialDelayMs: 10,
    maxDelayMs: 50,
  }).catch((e) => e);

  expect(err).toBeInstanceOf(AdapterRequestFailedError);
  // 429 exhaustion gets the more specific ADAPTER_RATE_LIMITED code
  expect(err.code).toBe("ADAPTER_RATE_LIMITED");
  expect(err.attempts).toBe(3);
  expect(fn).toHaveBeenCalledTimes(3);
});

test("6b. 429 followed by success retries and resolves", async () => {
  const fn = jest.fn();
  let calls = 0;
  fn.mockImplementation(async () => {
    calls++;
    if (calls === 1) throw new Error("429 Too Many Requests");
    return "rate-limit-recovered";
  });

  const result = await enqueueAdapterRequest(fn, "test-provider-6b", {
    maxRetries: 2,
    initialDelayMs: 10,
    maxDelayMs: 50,
  });

  expect(result).toBe("rate-limit-recovered");
  expect(fn).toHaveBeenCalledTimes(2);
});

// ── 7. Edge case F — idle queue doesn't appear as failure ────────────────────

test("7. idle queue (no requests) shows pending=0 and defined status", () => {
  // Before any requests the provider should not appear in statuses
  const statuses = getAllProviderQueueStatuses();
  expect(statuses).toHaveLength(0);

  // After one successful request the provider appears with lastOutcome=success
  // (async but we just want to ensure the status shape is valid — not a failure)
  const fn = jest.fn().mockResolvedValue("value");
  const promise = enqueueAdapterRequest(fn, "idle-provider", { maxRetries: 0 });

  // Before resolution — provider is registered
  const statusDuring = getProviderQueueStatus("idle-provider");
  expect(statusDuring).toBeDefined();
  expect(statusDuring!.provider).toBe("idle-provider");
  // lastOutcome is still undefined at queue-registration time (no attempt yet)
  expect(statusDuring!.lastOutcome).toBeUndefined();

  return promise.then(() => {
    const statusAfter = getProviderQueueStatus("idle-provider");
    expect(statusAfter!.lastOutcome).toBe("success");
    expect(statusAfter!.pendingCount).toBe(0);
  });
});

// ── 8. Edge case G — burst through single provider preserves order ────────────

test("8. burst of requests through single provider resolves in enqueue order", async () => {
  const order: number[] = [];
  const fns = [1, 2, 3].map((n) =>
    jest.fn(async () => {
      order.push(n);
      return n;
    }),
  );

  const [r1, r2, r3] = await Promise.all(
    fns.map((fn) =>
      enqueueAdapterRequest(fn, "ordered-provider", {
        maxRetries: 0,
        initialDelayMs: 10,
      }).then((v) => v as number),
    ),
  );

  expect([r1, r2, r3]).toEqual([1, 2, 3]);
  expect(order).toEqual([1, 2, 3]);
});

// ── 9. resilientFetch — 429 handling ─────────────────────────────────────────

describe("resilientFetch 429 patch", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    // Reset circuit breakers between tests
    const { resetAllCircuitBreakers } = require("../agents/resilientFetch");
    resetAllCircuitBreakers();
  });

  it("retries on 429 response and succeeds on second attempt", async () => {
    const { resilientFetch } = await import("../agents/resilientFetch");
    let callCount = 0;

    global.fetch = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response("", { status: 429 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const res = await resilientFetch(
      "https://example.com",
      { method: "GET" },
      "test-429-provider",
      { timeoutMs: 5000, maxRetries: 2, initialDelayMs: 5, maxDelayMs: 20 },
    );

    expect(res.status).toBe(200);
    expect(callCount).toBe(2);

    (global.fetch as jest.Mock).mockReset();
  });

  it("exhausts retries on repeated 429 and throws", async () => {
    const { resilientFetch } = await import("../agents/resilientFetch");

    global.fetch = jest.fn().mockResolvedValue(new Response("", { status: 429 }));

    await expect(
      resilientFetch(
        "https://example.com",
        { method: "GET" },
        "test-429-exhausted",
        { timeoutMs: 5000, maxRetries: 2, initialDelayMs: 5, maxDelayMs: 20 },
      ),
    ).rejects.toThrow(/429|rate limit/i);

    expect(global.fetch).toHaveBeenCalledTimes(3);

    (global.fetch as jest.Mock).mockReset();
  });

  it("does NOT retry on 400 Bad Request (non-retryable 4xx)", async () => {
    const { resilientFetch } = await import("../agents/resilientFetch");

    global.fetch = jest.fn().mockResolvedValue(new Response("", { status: 400 }));

    // 400 is not in the retry set; the response is returned as-is (not thrown)
    const res = await resilientFetch(
      "https://example.com",
      { method: "GET" },
      "test-400",
      { timeoutMs: 5000, maxRetries: 2, initialDelayMs: 5 },
    );

    // 400 is not >=500 so resilientFetch returns it without throwing
    expect(res.status).toBe(400);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    (global.fetch as jest.Mock).mockReset();
  });
});
