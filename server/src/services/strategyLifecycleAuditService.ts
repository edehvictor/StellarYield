import type {
  StrategyLifecycleEvent,
  StrategyLifecycleEventType,
} from "../types/strategyLifecycleEvents";

/**
 * Event-sourced audit log for strategy lifecycle events (#720).
 *
 * Events are appended in order and never mutated. The log is kept in-memory;
 * in production this would be backed by an append-only store (e.g. event
 * store, Kafka, or an immutable DB table).
 */
export class StrategyLifecycleAuditService {
  private readonly log: Map<string, StrategyLifecycleEvent[]> = new Map();

  /**
   * Append an event to the log for the strategy identified by event.strategyId.
   */
  recordEvent(event: StrategyLifecycleEvent): void {
    const { strategyId } = event;
    if (!this.log.has(strategyId)) {
      this.log.set(strategyId, []);
    }
    // Defensive copy to prevent callers mutating recorded events
    this.log.get(strategyId)!.push({ ...event });
  }

  /**
   * Return all recorded events for a strategy in insertion order.
   * Returns an empty array if no events exist for the strategyId.
   */
  getHistory(strategyId: string): StrategyLifecycleEvent[] {
    return (this.log.get(strategyId) ?? []).slice();
  }

  /**
   * Return the ordered list of event types recorded for a strategy.
   * Useful for asserting that the lifecycle proceeded in the expected order.
   */
  reconstructPath(strategyId: string): StrategyLifecycleEventType[] {
    return this.getHistory(strategyId).map((e) => e.type);
  }

  /**
   * Return true if the strategy has both a StrategyRecommended event and
   * at least one of StrategyExecuted or StrategyBlocked, indicating the
   * lifecycle reached a terminal state and can be fully traced.
   */
  isTraceable(strategyId: string): boolean {
    const events = this.getHistory(strategyId);
    const types = new Set(events.map((e) => e.type));

    return (
      types.has("StrategyRecommended") &&
      (types.has("StrategyExecuted") || types.has("StrategyBlocked"))
    );
  }

  /**
   * Return a list of all strategy IDs that have at least one recorded event.
   */
  listTrackedStrategies(): string[] {
    return Array.from(this.log.keys());
  }

  /**
   * Remove all recorded events — intended for test teardown only.
   */
  reset(): void {
    this.log.clear();
  }
}

export const strategyLifecycleAuditService = new StrategyLifecycleAuditService();
