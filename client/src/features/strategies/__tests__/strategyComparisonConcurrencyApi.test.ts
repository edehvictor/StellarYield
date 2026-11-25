/**
 * Regression tests for strategyComparisonConcurrencyApi (#1919)
 *
 * Covers:
 * 1. Normal fetch of versioned comparison state
 * 2. Normal save of versioned comparison state
 * 3. Conflict detection: 409 → StrategyComparisonConflictError
 * 4. Idempotent replay (isReplay: true)
 * 5. updateComparisonSafely: conflict resolved on second attempt (retry loop)
 * 6. Validation failure (400) does not throw StrategyComparisonConflictError
 * 7. Safe retry after conflict: same change applied to updated state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchComparisonStateVersioned,
  saveComparisonStateVersioned,
  selectStrategySafely,
  updateComparisonSafely,
  StrategyComparisonConflictError,
  type StrategyComparisonState,
} from '../strategyComparisonConcurrencyApi';

function makeState(overrides: Partial<StrategyComparisonState> = {}): StrategyComparisonState {
  return {
    walletAddress: 'GWALLET123',
    selectedStrategyId: null,
    pinnedStrategyIds: [],
    customAssumptions: {},
    allocatedBalances: {},
    updatedAt: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

function makeResponse(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const { status = 200, headers = {} } = options;
  const responseHeaders = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    json: async () => body,
  } as unknown as Response;
}

describe('strategyComparisonConcurrencyApi', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ─── 1. Normal fetch ────────────────────────────────────────────────────────
  describe('fetchComparisonStateVersioned', () => {
    it('returns state and version from response body', async () => {
      const state = makeState({ version: 3 });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse({ state, version: 3 }, { headers: { 'X-Comparison-Version': '3' } }),
      );

      const result = await fetchComparisonStateVersioned('GWALLET123');

      expect(result.state).toMatchObject({ walletAddress: 'GWALLET123', version: 3 });
      expect(result.version).toBe(3);
      expect(global.fetch).toHaveBeenCalledOnce();
      const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toMatch(/\/api\/strategies\/comparison\/state\/GWALLET123/);
    });

    it('reads version from X-Comparison-Version header when body version differs', async () => {
      const state = makeState({ version: 2 });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse({ state, version: 2 }, { headers: { 'X-Comparison-Version': '5' } }),
      );

      const result = await fetchComparisonStateVersioned('GWALLET123');
      // Header takes precedence
      expect(result.version).toBe(5);
    });

    it('reads version from ETag header when X-Comparison-Version is absent', async () => {
      const state = makeState({ version: 7 });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse({ state, version: 7 }, { headers: { ETag: '"7"' } }),
      );

      const result = await fetchComparisonStateVersioned('GWALLET123');
      expect(result.version).toBe(7);
    });

    it('throws an Error on non-OK response', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse({ error: 'Not found' }, { status: 404 }),
      );

      await expect(fetchComparisonStateVersioned('GWALLET123')).rejects.toThrow('Not found');
    });
  });

  // ─── 2. Normal save ─────────────────────────────────────────────────────────
  describe('saveComparisonStateVersioned', () => {
    it('sends If-Match and body expectedVersion on conditional write', async () => {
      const updatedState = makeState({ version: 2, selectedStrategyId: 'blend' });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(
          { state: updatedState, version: 2 },
          { headers: { 'X-Comparison-Version': '2' } },
        ),
      );

      const result = await saveComparisonStateVersioned(
        'GWALLET123',
        { selectedStrategyId: 'blend' },
        { expectedVersion: 1, operationIdentity: 'op-abc-123' },
      );

      expect(result.state.selectedStrategyId).toBe('blend');
      expect(result.version).toBe(2);
      expect(result.isReplay).toBeFalsy();

      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      const headers = init.headers as Record<string, string>;
      expect(headers['If-Match']).toBe('"1"');
      expect(headers['X-Operation-Identity']).toBe('op-abc-123');
      expect(headers['Idempotency-Key']).toBe('op-abc-123');
    });

    it('does not send If-Match when expectedVersion is not provided', async () => {
      const updatedState = makeState({ version: 1 });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse({ state: updatedState, version: 1 }),
      );

      await saveComparisonStateVersioned('GWALLET123', { pinnedStrategyIds: ['blend'] });

      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      const headers = init.headers as Record<string, string>;
      expect(headers['If-Match']).toBeUndefined();
    });
  });

  // ─── 3. Conflict detection ──────────────────────────────────────────────────
  describe('conflict detection (409)', () => {
    it('throws StrategyComparisonConflictError with currentVersion and currentState on 409', async () => {
      const serverState = makeState({ version: 4, selectedStrategyId: 'soroswap' });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(
          {
            code: 'STRATEGY_COMPARISON_VERSION_CONFLICT',
            error: 'Comparison state changed concurrently.',
            expectedVersion: 2,
            currentVersion: 4,
            state: serverState,
          },
          { status: 409 },
        ),
      );

      const err = await saveComparisonStateVersioned(
        'GWALLET123',
        { selectedStrategyId: 'blend' },
        { expectedVersion: 2 },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StrategyComparisonConflictError);
      expect((err as StrategyComparisonConflictError).currentVersion).toBe(4);
      expect((err as StrategyComparisonConflictError).currentState.selectedStrategyId).toBe('soroswap');
      expect((err as StrategyComparisonConflictError).code).toBe(
        'STRATEGY_COMPARISON_VERSION_CONFLICT',
      );
    });

    it('throws generic Error on 409 without recognized code', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse({ error: 'Unknown conflict' }, { status: 409 }),
      );

      await expect(
        saveComparisonStateVersioned('GWALLET123', {}, { expectedVersion: 1 }),
      ).rejects.toThrow('Unknown conflict');
    });

    it('throws StrategyComparisonConflictError on 409 from selectStrategySafely', async () => {
      const serverState = makeState({ version: 6 });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(
          {
            code: 'STRATEGY_COMPARISON_VERSION_CONFLICT',
            error: 'Strategy state changed.',
            currentVersion: 6,
            state: serverState,
          },
          { status: 409 },
        ),
      );

      const err = await selectStrategySafely('GWALLET123', 'blend', 1000, {
        expectedVersion: 3,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StrategyComparisonConflictError);
      expect((err as StrategyComparisonConflictError).currentVersion).toBe(6);
    });
  });

  // ─── 4. Idempotent replay ────────────────────────────────────────────────────
  describe('idempotent replay', () => {
    it('surfaces isReplay:true when server indicates a replayed operation', async () => {
      const replayedState = makeState({ version: 2, selectedStrategyId: 'blend' });
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse({ state: replayedState, version: 2, isReplay: true }),
      );

      const result = await saveComparisonStateVersioned(
        'GWALLET123',
        { selectedStrategyId: 'blend' },
        { operationIdentity: 'op-replay-999' },
      );

      expect(result.isReplay).toBe(true);
      expect(result.state.selectedStrategyId).toBe('blend');
    });
  });

  // ─── 5. updateComparisonSafely retry loop ───────────────────────────────────
  describe('updateComparisonSafely', () => {
    it('succeeds on first attempt when no conflict', async () => {
      const initialState = makeState({ version: 1 });
      const updatedState = makeState({ version: 2, pinnedStrategyIds: ['blend'] });

      global.fetch = vi
        .fn()
        // fetchComparisonStateVersioned (GET)
        .mockResolvedValueOnce(makeResponse({ state: initialState, version: 1 }))
        // saveComparisonStateVersioned (PUT)
        .mockResolvedValueOnce(
          makeResponse({ state: updatedState, version: 2 }),
        );

      const result = await updateComparisonSafely('GWALLET123', (current) => ({
        pinnedStrategyIds: [...current.pinnedStrategyIds, 'blend'],
      }));

      expect(result.state.pinnedStrategyIds).toContain('blend');
      expect(result.version).toBe(2);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries on first conflict and succeeds on second attempt', async () => {
      const stateV1 = makeState({ version: 1 });
      const stateV2 = makeState({ version: 2, pinnedStrategyIds: ['soroswap'] });
      const stateV3 = makeState({ version: 3, pinnedStrategyIds: ['soroswap', 'blend'] });

      global.fetch = vi
        .fn()
        // Attempt 1: GET v1
        .mockResolvedValueOnce(makeResponse({ state: stateV1, version: 1 }))
        // Attempt 1: PUT conflicts (another writer bumped to v2)
        .mockResolvedValueOnce(
          makeResponse(
            {
              code: 'STRATEGY_COMPARISON_VERSION_CONFLICT',
              error: 'Concurrent update',
              currentVersion: 2,
              state: stateV2,
            },
            { status: 409 },
          ),
        )
        // Attempt 2: GET now returns v2
        .mockResolvedValueOnce(makeResponse({ state: stateV2, version: 2 }))
        // Attempt 2: PUT succeeds at v3
        .mockResolvedValueOnce(makeResponse({ state: stateV3, version: 3 }));

      const result = await updateComparisonSafely('GWALLET123', (current) => ({
        pinnedStrategyIds: [...current.pinnedStrategyIds, 'blend'],
      }));

      expect(result.state.pinnedStrategyIds).toContain('blend');
      expect(result.state.pinnedStrategyIds).toContain('soroswap');
      expect(result.version).toBe(3);
      // 2 GETs + 2 PUTs = 4 calls
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    it('throws StrategyComparisonConflictError after exhausting all retries', async () => {
      // All attempts conflict
      const stateV1 = makeState({ version: 1 });
      const conflictBody = {
        code: 'STRATEGY_COMPARISON_VERSION_CONFLICT',
        error: 'Always conflicts',
        currentVersion: 99,
        state: makeState({ version: 99 }),
      };

      global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' || (typeof url === 'string' && url.includes('/state/'))) {
          return Promise.resolve(makeResponse({ state: stateV1, version: 1 }));
        }
        return Promise.resolve(makeResponse(conflictBody, { status: 409 }));
      });

      await expect(
        updateComparisonSafely('GWALLET123', (s) => ({ pinnedStrategyIds: [...s.pinnedStrategyIds, 'blend'] }), 3),
      ).rejects.toThrow();
    });
  });

  // ─── 6. Validation failure (400) ────────────────────────────────────────────
  describe('validation failure (400)', () => {
    it('throws a plain Error (not StrategyComparisonConflictError) on 400', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse(
          { error: 'protocolFeeBps must be between 0 and 10000' },
          { status: 400 },
        ),
      );

      const err = await saveComparisonStateVersioned(
        'GWALLET123',
        { customAssumptions: { protocolFeeBps: 99999 } },
        { expectedVersion: 1 },
      ).catch((e: unknown) => e);

      expect(err).not.toBeInstanceOf(StrategyComparisonConflictError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/protocolFeeBps/);
    });
  });

  // ─── 7. Safe retry after conflict preserves balances ────────────────────────
  describe('safe retry: state and balances preserved on conflict', () => {
    it('applies changeFn to the server newer state without data loss', async () => {
      const stateV1 = makeState({ version: 1, allocatedBalances: { blend: 500 } });
      // A concurrent writer added soroswap balance and bumped to v2
      const stateV2 = makeState({
        version: 2,
        allocatedBalances: { blend: 500, soroswap: 1000 },
      });
      const stateV3 = makeState({
        version: 3,
        allocatedBalances: { blend: 750, soroswap: 1000 },
      });

      global.fetch = vi
        .fn()
        // GET v1
        .mockResolvedValueOnce(makeResponse({ state: stateV1, version: 1 }))
        // PUT conflicts → current is v2 with soroswap balance
        .mockResolvedValueOnce(
          makeResponse(
            {
              code: 'STRATEGY_COMPARISON_VERSION_CONFLICT',
              currentVersion: 2,
              state: stateV2,
            },
            { status: 409 },
          ),
        )
        // GET v2
        .mockResolvedValueOnce(makeResponse({ state: stateV2, version: 2 }))
        // PUT succeeds at v3: both blend and soroswap balances preserved
        .mockResolvedValueOnce(makeResponse({ state: stateV3, version: 3 }));

      const result = await updateComparisonSafely('GWALLET123', (current) => ({
        allocatedBalances: { ...current.allocatedBalances, blend: 750 },
      }));

      // blend updated, soroswap from concurrent writer preserved
      expect(result.state.allocatedBalances.blend).toBe(750);
      expect(result.state.allocatedBalances.soroswap).toBe(1000);
    });
  });
});

