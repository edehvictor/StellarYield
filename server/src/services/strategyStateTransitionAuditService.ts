export type StrategyLifecycleState =
  | "healthy"
  | "degraded"
  | "frozen"
  | "recovered";

export interface StrategyStateTransitionTrigger {
  type: "health" | "operator";
  /**
   * Human-readable trigger context (reason/condition) safe for UI tooling.
   * Must not include secrets.
   */
  condition: string;
  operator?: string;
}

export interface StrategyStateTransitionRecord {
  id: string;
  strategyId: string;
  fromState: StrategyLifecycleState;
  toState: StrategyLifecycleState;
  triggeredAt: string; // ISO-8601
  trigger: StrategyStateTransitionTrigger;
}

export interface StrategyStateTransitionNode {
  id: string;
  strategyId: string;
  state: StrategyLifecycleState;
  timestamp: string; // ISO-8601
  label: string;
}

export interface StrategyStateTransitionEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  transitionId: string;
  label: string;
}

export interface StrategyStateTransitionGraph {
  strategyId: string;
  nodes: StrategyStateTransitionNode[];
  edges: StrategyStateTransitionEdge[];
}

const STATE_ORDER: StrategyLifecycleState[] = ["healthy", "degraded", "frozen", "recovered"];

// State machine for lifecycle auditing.
// We explicitly disallow some direct edges to keep semantics consistent.
const ALLOWED_TRANSITIONS: Record<StrategyLifecycleState, StrategyLifecycleState[]> = {
  healthy: ["healthy", "degraded", "frozen", "recovered"],
  degraded: ["healthy", "degraded", "frozen", "recovered"],
  frozen: ["frozen", "recovered"],
  recovered: ["healthy", "degraded", "frozen", "recovered"],
};

function formatStateLabel(state: StrategyLifecycleState): string {
  if (state === "frozen") return "Frozen";
  if (state === "recovered") return "Recovered";
  if (state === "degraded") return "Degraded";
  return "Healthy";
}

export class StrategyStateTransitionAuditService {
  private history: StrategyStateTransitionRecord[] = [];
  private lastStateByStrategy: Map<string, StrategyLifecycleState> = new Map();

  reset(): void {
    this.history = [];
    this.lastStateByStrategy.clear();
  }

  getLastState(strategyId: string): StrategyLifecycleState | undefined {
    return this.lastStateByStrategy.get(strategyId);
  }

  recordTransition(
    strategyId: string,
    toState: StrategyLifecycleState,
    trigger: StrategyStateTransitionTrigger,
    opts?: {
      /**
       * Used mainly for testing and backfills.
       * When omitted, the service uses the last recorded state.
       */
      fromStateOverride?: StrategyLifecycleState;
    },
  ): StrategyStateTransitionRecord | null {
    const fromState =
      opts?.fromStateOverride ?? this.lastStateByStrategy.get(strategyId);

    // Initial state for a strategy: store state but avoid creating a synthetic edge.
    if (!fromState) {
      this.lastStateByStrategy.set(strategyId, toState);
      return null;
    }

    if (fromState === toState) {
      return null;
    }

    const allowed = new Set(ALLOWED_TRANSITIONS[fromState]);
    if (!allowed.has(toState)) {
      throw new Error(
        `Invalid lifecycle transition ${fromState} → ${toState} for strategy ${strategyId}`,
      );
    }

    const record: StrategyStateTransitionRecord = {
      id: `state-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      strategyId,
      fromState,
      toState,
      triggeredAt: new Date().toISOString(),
      trigger,
    };

    this.history.push(record);
    this.lastStateByStrategy.set(strategyId, toState);

    return record;
  }

  updateFromHealth(
    strategyId: string,
    toState: StrategyLifecycleState,
    triggerCondition: string,
  ): StrategyStateTransitionRecord | null {
    return this.recordTransition(strategyId, toState, {
      type: "health",
      condition: triggerCondition,
    });
  }

  recordOperatorIntervention(
    strategyId: string,
    toState: StrategyLifecycleState,
    condition: string,
    operator?: string,
  ): StrategyStateTransitionRecord | null {
    return this.recordTransition(strategyId, toState, {
      type: "operator",
      condition,
      operator,
    });
  }

  getGraph(strategyId: string, limitTransitions = 100): StrategyStateTransitionGraph {
    const transitions = this.history.filter((r) => r.strategyId === strategyId);
    const sliced = transitions.slice(-Math.max(1, limitTransitions));

    const nodes: StrategyStateTransitionNode[] = [];
    const edges: StrategyStateTransitionEdge[] = [];

    let cursorNodeId: string | null = null;
    let cursorState: StrategyLifecycleState | null = null;

    for (const t of sliced) {
      if (!cursorState || cursorState !== t.fromState) {
        const nodeId = `node-${t.id}-from`;
        nodes.push({
          id: nodeId,
          strategyId,
          state: t.fromState,
          timestamp: t.triggeredAt,
          label: formatStateLabel(t.fromState),
        });
        cursorNodeId = nodeId;
        cursorState = t.fromState;
      }

      const toNodeId = `node-${t.id}-to`;
      nodes.push({
        id: toNodeId,
        strategyId,
        state: t.toState,
        timestamp: t.triggeredAt,
        label: formatStateLabel(t.toState),
      });

      edges.push({
        id: `edge-${t.id}`,
        fromNodeId: cursorNodeId!,
        toNodeId,
        transitionId: t.id,
        label: `${formatStateLabel(t.fromState)} → ${formatStateLabel(t.toState)}`,
      });

      cursorNodeId = toNodeId;
      cursorState = t.toState;
    }

    return { strategyId, nodes, edges };
  }

  /**
   * Useful for tooling/debug. Intended for non-sensitive internal diagnostics.
   */
  getHistory(strategyId: string): StrategyStateTransitionRecord[] {
    return this.history.filter((r) => r.strategyId === strategyId).slice();
  }
}

export const strategyStateTransitionAuditService =
  new StrategyStateTransitionAuditService();

