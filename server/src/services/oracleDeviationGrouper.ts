/**
 * Oracle Deviation Alert Grouping (#1093)
 *
 * Groups DeviationEvents from the oracle deviation sentinel by asset and
 * severity band so burst alerts collapse into a single operator-facing view.
 *
 * Delegates clustering / dedup / severity-breakdown logic to DriftAnomalyGrouper
 * so both drift and oracle-deviation alerts share the same grouping semantics.
 */

import {
  driftAnomalyGrouper,
  type DriftSignal,
  type GroupedAnomaly,
  type AnomalySeverityBand,
  type GroupingOptions,
} from "./driftAnomalyGrouper";
import type { DeviationEvent, OracleState, ExecutionDecision } from "./oracleDeviationSentinel";

/** Map an OracleState + ExecutionDecision to the shared severity band scale. */
export function severityFromEvaluation(state: OracleState, decision: ExecutionDecision): AnomalySeverityBand {
  if (state === "MISSING" || state === "STALE") return "CRITICAL";
  if (state === "DEVIATED" || decision === "BLOCK") return "HIGH";
  if (decision === "DOWNGRADE") return "MEDIUM";
  return "LOW";
}

/** Convert a DeviationEvent into the generic DriftSignal shape used by the grouper. */
export function toDriftSignal(event: DeviationEvent): DriftSignal {
  const severity = severityFromEvaluation(event.evaluation.state, event.evaluation.decision);
  const price = event.reading?.price ?? 0;
  const reference = event.referencePrice ?? 0;

  return {
    id: event.id,
    source: "strategy",
    subSource: "oracle_deviation",
    asset: event.assetId,
    metric: `oracle_${event.evaluation.state.toLowerCase()}`,
    currentValue: price,
    expectedValue: reference,
    deviation: event.evaluation.deviationPct ?? 0,
    severity,
    timestamp: event.timestamp,
    metadata: {
      oracleState: event.evaluation.state,
      executionDecision: event.evaluation.decision,
      reasons: event.evaluation.reasons,
    },
  };
}

/**
 * Group a list of DeviationEvents by asset + severity band.
 * Duplicate events within the dedup window collapse into a single group.
 */
export function groupOracleDeviations(
  events: DeviationEvent[],
  options: GroupingOptions = {},
): GroupedAnomaly[] {
  if (!events || events.length === 0) return [];
  const signals = events.map(toDriftSignal);
  return driftAnomalyGrouper.groupSignals(signals, options);
}
