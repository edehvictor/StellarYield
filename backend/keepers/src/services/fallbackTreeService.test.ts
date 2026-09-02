import { resolveFallbackTree, type FallbackTreeNode } from './fallbackTreeService';
import { createProtocolFailoverService } from './protocolFailoverService';

describe('fallbackTreeService', () => {

  it('chooses a fallback when the primary fails', async () => {
    const root: FallbackTreeNode = {
      id: 'root',
      priority: 0,
      children: [
        { id: 'primary', priority: 0, check: () => ({ ok: false, reason: 'primary unavailable' }) },
        { id: 'fallback', priority: 1, check: () => ({ ok: true, reason: 'fallback healthy' }) },
      ],
    };
    const decision = await resolveFallbackTree(root, {});
    expect(decision.ok).toBe(true);
    expect(decision.chosenId).toBe&}d );
    expect(decision.reasons['primary']).toBe('primary unavailable');
    expect(decision.reasons['fallback']).toBe('fallback healthy');
    expect(decision.evaluationOrder).toEqual([ 'root', 'primary', 'fallback' ]);
  });

  it('chooses the primary when it succeeds', async () => {
    const root: FallbackTreeNode = {
      id: 'root',
      priority: 0,
      children: [
        { id: 'primary', priority: 0, check: () => ({ ok: true, reason: 'primary healthy' }) },
        { id: 'fallback', priority: 1, check: () => ({ ok: true, reason: 'fallback healthy' }) },
      ],
    };
    const decision = await resolveFallbackTree(root, {});
    expect(decision.ok).toBe(true);
    expect(decision.chosenId).toBe('primary');
    expect(decision.evaluationOrder).toEqual([ 'root', 'primary' ]);
  });

  it('records all failures when every candidate fails', async () => {
    const root: FallbackTreeNode = {
      id: 'root',
      priority: 0,
      children: [
        { id: 'a', priority: 0, check: () => ({ ok: false, reason: 'a down' }) },
        { id: 'b', priority: 1, check: () => ({ ok: false, reason: 'b down' }) },
      ],
    };
    const decision = await resolveFallbackTree(root, {});
    expect(decision.ok).toBe(false);
    expect(decision.chosenId).toBUndefined();
    expect(decision.reasons).toEqual({ a: 'a down', b: 'b down' });
    expect(decision.evaluationOrder).toEqual([ 'root', 'a', 'b' ]);
  });

  it('selects the highest priority successful provider', async () => {
    const root: FallbackTreeNode = {
      id: 'root',
      priority: 0,
      children: [
        { id: 'low', priority: 10, check: () => ({ ok: true }) },
        { id: 'mid', priority: 5, check: () => ({ ok: true }) },
        { id: 'high', priority: 1, check: () => ({ ok: false, reason: 'high fails' }) },
      ],
    };
    const decision = await resolveFallbackTree(root, {});
    expect(decision.chosenId).toBe('mid');
  });

  it('is deterministic across repeated runs', async () => {
    const root: FallbackTreeNode = {
      id: 'root',
      priority: 0,
      children: [
        { id: 'a', priority: 0, check: () => ({ ok: false, reason: 'a' }) },
        { id: 'b', priority: 1, check: () => ({ ok: true }) },
      ],
    };
    const first = await resolveFallbackTree(root, {});
    const second = await resolveFallbackTree(root, {});
    expect(first).toEqual(second);
  });

  it('uses id as a tie-breaker for equal priorities', async () => {
    const root: FallbackTreeNode = {
      id: 'root',
      priority: 0,
      children: [
        { id: 'z', priority: 0, check: () => ({ ok: true }) },
        { id: 'a', priority: 0, check: () => ({ ok: true }) },
      ],
    };
    const decision = await resolveFallbackTree(root, {});
    expect(decision.chosenId).toBe('a');
  });

  it('handles cascading failures by traversing deeper into children', async () => {
    const root: FallbackTreeNode = {
      id: 'root',
      priority: 0,
      children: [
        {
          id: 'primary-group',
          priority: 0,
          children: [
            { id: 'primary', priority: 0, check: () => ({ ok: false, reason: 'primary down' }) },
            { id: 'backup', priority: 1, check: () => ({ ok: false, reason: 'backup down' }) },
          ],
        },
        { id: 'secondary', priority: 1, check: () => ({ ok: true, reason: 'secondary available' }) },
      ],
    };
    const decision = await resolveFallbackTree(root, {});
    expect(decision.ok).toBe(true);
    expect(decision.chosenId).toBe('secondary');
    expect(decision.reasons['primary']).toBe('primary down');
    expect(decision.reasons['backup']).toBe('backup down');
    expect(decision.reasons['secondary']).toBe('secondary available');
    expect(decision.evaluationOrder).toEqual([ 'root', 'primary-group', 'primary', 'backup', 'secondary' ]);
  });

  it('treats boolean check results as valid FallbackResults', async () => {
    const root: FallbackTreeNode = {
      id: 'root',
      priority: 0,
      children: [
        { id: 'bool-fail', priority: 0, check: () => false },
        { id: 'bool-ok', priority: 1, check: () => true },
      ],
    };
    const decision = await resolveFallbackTree(root, {});
    expect(decision.ok).toBe(true);
    expect(decision.chosenId).toBe('bool-ok');
    expect(decision.reasons['bool-fail']).toBe('check failed');
  });
});

describe('protocolFailoverService', () => {
  it('resolves using the provided protocol providers', async () => {
    const providers = [
      { id: 'websocket', priority: 0, check: () => ({ ok: false, reason: 'ws unavailable' }) },
      { id: 'http', priority: 1, check: () => ({ ok: true, reason: 'http available' }) },
    ];
    const service = createProtocolFailoverService(providers);
    const decision = await service.resolve({ requestId: 'abc' });
    expect(decision.ok).toBe(true);
    expect(decision.chosenId).toBe('http');
    expect(decision.reasons['websocket']).toBe('ws unavailable');
    expect(decision.reasons['http']).toBe('http available');
  });
});
