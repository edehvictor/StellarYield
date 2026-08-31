/**
 * Health Score Change & Dependency Alert Service (#1100)
 *
 * Evaluates strategy score changes and dependency graph health transitions.
 * Dispatches operator alerts when service dependencies degrade or recover.
 */

export * from "./healthScoreChangeAlertService";

import type { ServiceDependencyGraph, ServiceId } from "../monitoring/dependencyGraph";

export interface DependencyHealthAlert {
  serviceId: ServiceId;
  serviceName: string;
  previousStatus: string;
  currentStatus: string;
  isRootCause: boolean;
  impactedServices: ServiceId[];
  timestamp: string;
  hint?: string;
}

const previousDependencyStatuses = new Map<ServiceId, string>();
const dependencyAlertHistory: DependencyHealthAlert[] = [];
const MAX_DEPENDENCY_HISTORY = 100;

/**
 * Evaluates changes in the service dependency graph and generates alerts for status transitions.
 */
export function evaluateDependencyGraphAlerts(
  graph: ServiceDependencyGraph,
): DependencyHealthAlert[] {
  const alerts: DependencyHealthAlert[] = [];

  for (const node of graph.nodes) {
    const prev = previousDependencyStatuses.get(node.id);
    const curr = node.status;

    // Track current status
    previousDependencyStatuses.set(node.id, curr);

    if (prev && prev !== curr) {
      const isRootCause = graph.summary.rootCauses.includes(node.id);
      const impactedServices = graph.summary.blastRadius[node.id] ?? [];

      const alert: DependencyHealthAlert = {
        serviceId: node.id,
        serviceName: node.name,
        previousStatus: prev,
        currentStatus: curr,
        isRootCause,
        impactedServices,
        timestamp: graph.generatedAt,
        hint: node.hint,
      };

      alerts.push(alert);
      dependencyAlertHistory.unshift(alert);
      if (dependencyAlertHistory.length > MAX_DEPENDENCY_HISTORY) {
        dependencyAlertHistory.length = MAX_DEPENDENCY_HISTORY;
      }
    }
  }

  return alerts;
}

export function getDependencyAlertHistory(limit: number = 50): DependencyHealthAlert[] {
  return dependencyAlertHistory.slice(0, limit);
}

export function resetDependencyAlertState(): void {
  previousDependencyStatuses.clear();
  dependencyAlertHistory.length = 0;
}
