/**
 * Unit tests for resilience utilities (CircuitBreaker + fetchWithRetry).
 *
 * Validates Requirements: 7.3, 7.4 (error handling & graceful degradation).
 */

import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  fetchWithRetry,
  sleep,
} from '../../services/fragmentation/resilience';
import { MetricAggregator, IYieldService, NormalizedYield } from '../../services/fragmentation/MetricAggregator';
import { FragmentationError } from '../../services/fragmentation/types';

describe('CircuitBreaker', () => {
  describe('open/close lifecycle', () => {
    it('opens after failureThreshold consecutive failures', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
      let call = 0;

      const fn = jest.fn(async () => {
        call += 1;
        throw new Error('boom');
      });

      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(fn)).rejects.toThrow('boom');
      }

      expect(breaker.getState()).toBe('OPEN');
      expect(breaker.getFailureCount()).toBe(3);
      await expect(breaker.execute(fn)).rejects.toThrow(CircuitBreakerOpenError);
      expect(fn).toHaveBeenCalledTimes(3); // fail-fast call did not invoke fn
    });

    it('closes again on a successful probe after the reset timeout', async () => {
      jest.useFakeTimers();
      const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 10_000 });
      const failFn = jest.fn(async () => {
        throw new Error('boom');
      });
      const okFn = jest.fn(async () => 'ok');

      await expect(breaker.execute(failFn)).rejects.toThrow('boom');
      await expect(breaker.execute(failFn)).rejects.toThrow('boom');
      expect(breaker.getState()).toBe('OPEN');

      // Before timeout elapses: fail fast.
      await expect(breaker.execute(okFn)).rejects.toThrow(CircuitBreakerOpenError);
      expect(okFn).not.toHaveBeenCalled();

      // After timeout: probe goes through as HALF_OPEN.
      jest.advanceTimersByTime(10_001);
      await expect(breaker.execute(okFn)).resolves.toBe('ok');
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getFailureCount()).toBe(0);

      jest.useRealTimers();
    });

    it('re-opens if the HALF_OPEN probe fails', async () => {
      jest.useFakeTimers();
      const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 10_000 });
      const failFn = jest.fn(async () => {
        throw new Error('boom');
      });

      await expect(breaker.execute(failFn)).rejects.toThrow('boom');
      await expect(breaker.execute(failFn)).rejects.toThrow('boom');
      expect(breaker.getState()).toBe('OPEN');

      jest.advanceTimersByTime(10_001);
      await expect(breaker.execute(failFn)).rejects.toThrow('boom');
      expect(breaker.getState()).toBe('OPEN');
      expect(breaker.getFailureCount()).toBe(3);

      jest.useRealTimers();
    });

    it('reset() returns the breaker to CLOSED', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
      await expect(
        breaker.execute(async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect(breaker.getState()).toBe('OPEN');

      breaker.reset();
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getFailureCount()).toBe(0);
      await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    });
  });
});

describe('fetchWithRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves on the first attempt', async () => {
    const fn = jest.fn(async () => 'value');
    await expect(fetchWithRetry(fn, 3, 10)).resolves.toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries with exponential backoff until success', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('transient');
      }
      return 'recovered';
    });

    const pending = fetchWithRetry(fn, 3, 100);

    // attempt 1 fails → wait 100ms; attempt 2 fails → wait 200ms; attempt 3 succeeds
    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error once retries are exhausted', async () => {
    const fn = jest.fn(async () => {
      throw new Error('persistent');
    });

    // Attach the rejection handler before advancing timers so the rejection
    // is never observed as "unhandled".
    const pending = fetchWithRetry(fn, 2, 100);
    const assertion = expect(pending).rejects.toThrow('persistent');

    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(200);

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('fails immediately when maxRetries is 0', async () => {
    const fn = jest.fn(async () => {
      throw new Error('instant');
    });
    await expect(fetchWithRetry(fn, 0, 100)).rejects.toThrow('instant');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('sleep resolves after the delay', async () => {
    const fn = jest.fn(() => sleep(500));
    const pending = fn();
    await jest.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('MetricAggregator + CircuitBreaker integration', () => {
  it('fails fast without invoking the dependency once the breaker is open', async () => {
    const mockYieldService: IYieldService = {
      getYieldData: jest.fn(async () => {
        throw new Error('Service unavailable');
      }),
    };

    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const aggregator = new MetricAggregator(mockYieldService, 300, { circuitBreaker: breaker });

    await expect(aggregator.aggregatePoolDepth()).rejects.toThrow(FragmentationError);
    await expect(aggregator.aggregatePoolDepth()).rejects.toThrow(FragmentationError);
    expect(breaker.getState()).toBe('OPEN');

    // Third call is rejected by the circuit breaker without hitting the service.
    await expect(aggregator.aggregatePoolDepth()).rejects.toThrow(FragmentationError);
    expect(mockYieldService.getYieldData).toHaveBeenCalledTimes(2);
  });

  it('returns stale cached data while the breaker recovers', async () => {
    const healthyData: NormalizedYield[] = [
      { protocol: 'Blend', tvl: 12400000, apy: 8.5, poolCount: 50 },
    ];

    const mockYieldService: IYieldService = {
      getYieldData: jest.fn(),
    };

    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const aggregator = new MetricAggregator(mockYieldService, 300, { circuitBreaker: breaker });

    (mockYieldService.getYieldData as jest.Mock).mockResolvedValueOnce(healthyData);
    try {
      await aggregator.aggregatePoolDepth();
      (mockYieldService.getYieldData as jest.Mock).mockRejectedValue(new Error('down'));

      // Failures degrade gracefully by returning the cached snapshot as stale.
      const stale1 = await aggregator.aggregatePoolDepth();
      expect(stale1.dataCompleteness.isStale).toBe(true);

      const stale2 = await aggregator.aggregatePoolDepth();
      expect(stale2.dataCompleteness.isStale).toBe(true);
      expect(breaker.getState()).toBe('OPEN');

      // Fast-fail path still surfaces the stale cached snapshot with isStale=true.
      const stale3 = await aggregator.aggregatePoolDepth();
      expect(stale3.dataCompleteness.isStale).toBe(true);
      expect((mockYieldService.getYieldData as jest.Mock).mock.calls.length).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });
});