import crypto from "crypto";
import type {
  StrategyLifecycleEvent,
  StrategyLifecycleEventType,
} from "../types/strategyLifecycleEvents";

/**
 * Event-sourced audit log for strategy lifecycle events (#34).
 *
 * Events are appended in order and never mutated.  The log is keyed by
 * strategyId *and* correlationId so callers can replay a full chain from
 * recommendation through execution or failure.
 *
 * In production this would be backed by an append-only store (e.g. an
 * immutable DB table, Kafka, or an event-store service).
 */
export class StrategyLifecycleAuditService {
  private readonly log: Map<string, StrategyLifecycleEvent[]> = new Map();

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Generate a stable unique event ID. */
  static generateEventId(): string {
    return `evt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }

  /** Generate a new correlationId for a fresh recommendation chain. */
  static generateCorrelationId(): string {
    return `corr-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  }

  /**
   * SHA-256 hex of a payload object.  Used to populate `sourceDataHash` so
   * audit replays can verify the input data was not tampered with.
   */
  static hashPayload(payload: unknown): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
  }

  // ── write ──────────────────────────────────────────────────────────────────

  /**
   * Append an event to the log for the strategy identified by event.strategyId.
   */
  recordEvent(event: StrategyLifecycleEvent): void {
    const { strategyId } = event;
    if (!this.log.has(strategyId)) {
      this.log.set(strategyId, []);
    }
    // Defensive copy — prevent callers mutating recorded events.
    this.log.get(strategyId)!.push({ ...event });
  }

  // ── read ───────────────────────────────────────────────────────────────────

  /**
   * Return all recorded events for a strategy in insertion order.
   */
  getHistory(strategyId: string): StrategyLifecycleEvent[] {
    return (this.log.get(strategyId) ?? []).slice();
  }

  /**
   * Return all events that share the given correlationId, across any strategy.
   * Events are returned in timestamp order.
   */
  getByCorrelationId(correlationId: string): StrategyLifecycleEvent[] {
    const results: StrategyLifecycleEvent[] = [];
    for (const events of this.log.values()) {
      for (const e of events) {
        if (e.correlationId === correlationId) {
          results.push({ ...e });
        }
      }
    }
    return results.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Return the ordered list of event types recorded for a strategy.
   */
  reconstructPath(strategyId: string): StrategyLifecycleEventType[] {
    return this.getHistory(strategyId).map((e) => e.type);
  }

  /**
   * True if the strategy has both a StrategyRecommended event and at least one
   * terminal event (StrategyExecuted or StrategyBlocked), meaning the full
   * chain can be traced.
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
   * Return a summary of the lifecycle chain identified by correlationId,
   * including all event types present and whether the chain reached a terminal
   * state.
   */
  getCorrelationSummary(correlationId: string): {
    correlationId: string;
    strategyId: string | null;
    events: StrategyLifecycleEvent[];
    path: StrategyLifecycleEventType[];
    isComplete: boolean;
  } {
    const events = this.getByCorrelationId(correlationId);
    const path = events.map((e) => e.type);
    const types = new Set(path);
    const strategyId = events[0]?.strategyId ?? null;

    return {
      correlationId,
      strategyId,
      events,
      path,
      isComplete:
        types.has("StrategyRecommended") &&
        (types.has("StrategyExecuted") || types.has("StrategyBlocked")),
    };
  }

  /**
   * Return all strategy IDs that have at least one recorded event.
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
