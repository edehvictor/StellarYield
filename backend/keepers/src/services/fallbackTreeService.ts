/**
 * Fallback tree resolution with deterministic ordering and traceable failures.
 */

export interface FallbackContext {
  key: string;
}

export interface FallbackResult {
  ok: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface FallbackTreeNode {
  id: string;
  priority: number;
  check?: (context: FallbackContext) => Promise<FallbackResult | boolean> | FallbackResult | boolean;
  children?: FallbackTreeNode[];
}
export interface FallbackDecision {
  ok: boolean;
  chosenId?: string;
  chosenNode?: FallbackTreeNode;
  /** Candidate/node id -> reason for the last evaluation. */
  reasons: Record<string, string>;
  /** Order in which nodes were visited. */
  evaluationOrder: string[];
}

export interface FallbackResolveOptions {
  /** When true, throws if no node succeeds */
  throwOnFailure?: boolean;
}

/**
 * Normalizes the return value of a check function to a FallbackResult.
 */
function normalizeResult(result: unknown): FallbackResult {
  if (typeof result === 'boolean') {
    return result ? { ok: true, reason: 'accepted' } : { ok: false, reason: 'check failed' };
  }
  if (result && typeof result === 'object' && 'ok' in (result as any)) {
    const r = result as any;
    // Only an explicit `true` counts as success; this avoids
    // accidentally accepting truthy non-boolean values.
    return {
      ok: r.ok === true,
      reason: r.reason ?? (r.ok === true ? 'accepted' : 'check failed'),
    };
  }
  return { ok: false, reason: 'invalid check result' };
}

/**
 * Resolves a fallback tree deterministically.
 *
 * Nodes are visited in ascending `priority` order (with `id` as a
 * stable tie-breaker) at each level. The first node whose check returns
 * `ok: true` is chosen; all failed nodes are recorded in `reasons`.
 */
export async function resolveFallbackTree(
  root: FallbackTreeNode,
  context: FallbackContext,
  options: FallbackResolveOptions = {},
): Promise<FallbackDecision> {
  const reasons: Record<string, string> = {};
  const evaluationOrder: string[] = [];
  let chosenId: string | undefined;
  let chosenNode: FallbackTreeNode | undefined;

  async function visit(node: FallbackTreeNode): Promise<boolean> {
    evaluationOrder.push(node.id);

    if (node.check) {
      let result: FallbackResult;
      try {
        result = normalizeResult(await node.check(context));
      } catch (err) {
        result = {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      if (result.ok) {
        reasons[node.id] = result.reason ?? 'accepted';
        chosenId = node.id;
        chosenNode = node;
        return true;
      }

      reasons[node.id] = result.reason ?? 'check failed';
    }

    const children = [...(node.children ?? [])].sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.id.localeCompare(b.id);
    });

    for (const child of children) {
      if (await visit(child)) {
        return true;
      }
    }

    return false;
  }

  const ok = await visit(root);

  const decision: FallbackDecision = {
    ok,
    reasons,
    evaluationOrder,
  };

  if (ok) {
    decision.chosenId = chosenId;
    decision.chosenNode = chosenNode;
  }

  if (!ok && options.throwOnFailure) {
    throw new Error(
      `All fallback nodes failed. Reasons: ${JSON.stringify(reasons)}`,
    );
  }

  return decision;
}
