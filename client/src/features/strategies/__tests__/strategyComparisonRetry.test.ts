/**
 * Strategy comparison client retry (#1923).
 *
 * A lost response is resent with the same operation identity, so the server
 * can replay a write it already kept. Final answers (409, 422, 4xx) are never
 * resent, and an unconfirmed write surfaces as "outcome unknown" with the
 * identity needed to resolve or retry it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchComparisonOperation,
  saveComparisonStateVersioned,
  selectStrategySafely,
  StrategyComparisonConflictError,
  StrategyComparisonIdempotencyMismatchError,
  StrategyComparisonOutcomeUnknownError,
  type StrategyComparisonState,
} from '../strategyComparisonConcurrencyApi';

const NO_DELAY = { retryDelaysMs: [0] } as const;

function makeState(overrides: Partial<StrategyComparisonState> = {}): StrategyComparisonState {
  return {
    walletAddress: 'GWALLET123',
    selectedStrategyId: 'blend',
    pinnedStrategyIds: [],
    customAssumptions: {},
    allocatedBalances: { blend: 1000 },
    updatedAt: '2026-11-25T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function makeResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

function sentIdentities(): string[] {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => {
    const headers = (init as RequestInit).headers as Record<string, string>;
    return headers['Idempotency-Key'];
  });
}

describe('strategy comparison retry (#1923)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('sends a generated identity when the caller gives none', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeResponse({ state: makeState(), version: 1 }));
    await saveComparisonStateVersioned('GWALLET123', { pinnedStrategyIds: ['blend'] });
    const [id] = sentIdentities();
    expect(id).toMatch(/^cmp-/);
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.operationIdentity).toBe(id);
  });

  it('resends a lost response with the same identity and accepts the replay', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(makeResponse({ error: 'upstream reset' }, 503))
      .mockResolvedValueOnce(
        makeResponse({ state: makeState(), version: 1, isReplay: true }, 200, { 'X-Comparison-Version': '1' }),
      );

    const result = await selectStrategySafely('GWALLET123', 'blend', 1000, {
      expectedVersion: 0,
      operationIdentity: 'sel-lost',
      ...NO_DELAY,
    });

    expect(result.isReplay).toBe(true);
    expect(result.state.allocatedBalances).toEqual({ blend: 1000 });
    expect(sentIdentities()).toEqual(['sel-lost', 'sel-lost', 'sel-lost']);
    const bodies = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => (init as RequestInit).body);
    expect(new Set(bodies).size).toBe(1);
  });

  it('reports an unknown outcome with the identity after every retry fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const err = await selectStrategySafely('GWALLET123', 'blend', 1000, {
      operationIdentity: 'sel-down',
      transportRetries: 2,
      ...NO_DELAY,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StrategyComparisonOutcomeUnknownError);
    expect((err as StrategyComparisonOutcomeUnknownError).operationIdentity).toBe('sel-down');
    expect((err as Error).message).toMatch(/retrying is safe/);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('never resends a conflict', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeResponse(
        { code: 'STRATEGY_COMPARISON_VERSION_CONFLICT', error: 'changed', currentVersion: 4, state: makeState({ version: 4 }) },
        409,
      ),
    );
    await expect(
      selectStrategySafely('GWALLET123', 'blend', 1000, { expectedVersion: 1, ...NO_DELAY }),
    ).rejects.toBeInstanceOf(StrategyComparisonConflictError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a reused identity as a mismatch and does not resend', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeResponse({ code: 'STRATEGY_COMPARISON_IDEMPOTENCY_MISMATCH', error: 'already used' }, 422),
    );
    const err = await saveComparisonStateVersioned(
      'GWALLET123',
      { pinnedStrategyIds: ['x'] },
      { operationIdentity: 'reused', ...NO_DELAY },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StrategyComparisonIdempotencyMismatchError);
    expect((err as StrategyComparisonIdempotencyMismatchError).operationIdentity).toBe('reused');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not resend a validation failure', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeResponse({ error: 'bad bps' }, 400));
    await expect(
      saveComparisonStateVersioned('GWALLET123', { customAssumptions: { protocolFeeBps: -1 } }, NO_DELAY),
    ).rejects.toThrow('bad bps');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  describe('fetchComparisonOperation', () => {
    it('returns the committed outcome', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        makeResponse({ status: 'committed', operationIdentity: 'op', kind: 'select', baseVersion: 0, version: 1, state: makeState(), attempts: 1 }),
      );
      const op = await fetchComparisonOperation('G W', 'op/1');
      expect(op.status).toBe('committed');
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
        /\/comparison\/operations\/G%20W\/op%2F1$/,
      );
    });

    it('maps 404 to unknown, meaning retry is safe', async () => {
      global.fetch = vi.fn().mockResolvedValue(makeResponse({ code: 'STRATEGY_COMPARISON_OPERATION_NOT_FOUND' }, 404));
      await expect(fetchComparisonOperation('GWALLET123', 'never')).resolves.toEqual({
        status: 'unknown',
        operationIdentity: 'never',
      });
    });
  });
});
