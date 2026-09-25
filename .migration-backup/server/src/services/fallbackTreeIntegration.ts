/**
 * Fallback Tree Integration Layer
 *
 * Integrates the hierarchical fallback tree with existing strategy services
 * to provide degraded recommendation paths when primary strategies fail.
 *
 * This layer bridges the fallback tree service with:
 * - Strategy Health Service for health checks
 * - Protocol Failover Service for blocklist checks
 * - Strategy Rotation Service for candidate prioritization
 */

import {
  fallbackTreeRegistry,
  type FallbackNode,
  type TraversalContext,
  type TraversalResult,
  createFallbackTreeFromList,
  formatTraversalResult,
  extractFailedNodes,
} from './fallbackTreeService';
import {
  strategyHealthEngine,
  type StrategyHealthScore,
  isStrategySafeForExecution,
} from './strategyHealthService';
import {
  failoverRegistry,
  type ProtocolHealthInput,
} from './protocolFailoverService';
import {
  rotationRegistry,
  type RotationCandidate,
} from './strategyRotationService';

// ── Types ───────────────────────────────────────────────────────────────

export interface StrategyRecommendationContext {
  /** Current strategy ID (if any) */
  currentStrategyId?: string;
  /** Available strategies with their metadata */
  availableStrategies: Array<{
    id: string;
    name: string;
    priority?: number;
    protocolId?: string;
  }>;
  /** Minimum health score threshold */
  minHealthScore?: number;
  /** Whether to allow degraded strategies */
  allowDegraded?: boolean;
  /** Maximum fallback depth */
  maxDepth?: number;
}

export interface RecommendationResult {
  /** Recommended strategy */
  recommendedStrategy: {
    id: string;
    name: string;
  } | null;
  /** Full fallback tree traversal result */
  traversalResult: TraversalResult;
  /** Whether recommendation was made from fallback */
  isFallback: boolean;
  /** Fallback depth (0 = primary, >0 = fallback level) */
  fallbackDepth: number;
  /** Human-readable explanation */
  explanation: string;
  /** Timestamp of recommendation */
  recommendedAt: string;
}

// ── Integration Functions ───────────────────────────────────────────────

/**
 * Create a fallback tree from available strategies with optional priority ordering
 */
export function createStrategyFallbackTree(
  strategies: Array<{ id: string; name: string; priority?: number }>,
  sortBy: 'priority' | 'health' | 'rotation' = 'priority',
): FallbackNode {
  if (sortBy === 'priority') {
    return createFallbackTreeFromList(strategies);
  }

  // For other sorting modes, we'd need to fetch additional data
  // For now, default to priority-based sorting
  return createFallbackTreeFromList(strategies);
}

/**
 * Get strategy health check function integrated with StrategyHealthService
 */
function createStrategyHealthChecker(minHealthScore: number = 50) {
  return async (strategyId: string) => {
    try {
      const healthScore = await strategyHealthEngine.calculateHealthScore(
        strategyId,
        `Strategy ${strategyId}`,
      );

      return {
        status: healthScore.status as 'healthy' | 'degraded' | 'critical' | 'blocked' | 'unknown',
        score: healthScore.overallScore,
        checkedAt: healthScore.lastUpdated,
        reasons: healthScore.recommendations,
      };
    } catch (error) {
      // If health check fails, treat as unknown status
      return {
        status: 'unknown' as const,
        score: 0,
        checkedAt: new Date().toISOString(),
        reasons: ['Health check failed'],
      };
    }
  };
}

/**
 * Get strategy blocklist check function integrated with ProtocolFailoverService
 */
function createStrategyBlocklistChecker() {
  return async (strategyId: string) => {
    const excludedProtocols = failoverRegistry.excludedProtocols();
    const isExcluded = excludedProtocols.includes(strategyId);

    return {
      isBlocked: isExcluded,
      reason: isExcluded ? 'Excluded by protocol failover service' : undefined,
      checkedAt: new Date().toISOString(),
    };
  };
}

/**
 * Get recommendation using fallback tree traversal in degraded paths
 *
 * This is the main integration point for using fallback trees in recommendation
 * paths. It:
 * 1. Creates a fallback tree from available strategies
 * 2. Traverses the tree using health and blocklist checks
 * 3. Returns the first viable strategy with full audit trail
 */
export async function getStrategyRecommendation(
  context: StrategyRecommendationContext,
): Promise<RecommendationResult> {
  const now = Date.now();
  const minHealthScore = context.minHealthScore ?? 50;
  const allowDegraded = context.allowDegraded ?? true;
  const maxDepth = context.maxDepth ?? 20;

  // Create fallback tree from available strategies
  const tree = createStrategyFallbackTree(context.availableStrategies, 'priority');

  // Register tree temporarily for this recommendation
  const treeKey = `recommendation-${now}`;
  fallbackTreeRegistry.registerTree(treeKey, tree);

  try {
    // Create traversal context with integrated health and blocklist checks
    const traversalContext: TraversalContext = {
      checkHealth: createStrategyHealthChecker(minHealthScore),
      checkBlocklist: createStrategyBlocklistChecker(),
      minHealthScore,
      allowDegraded,
      maxDepth,
      now,
    };

    // Traverse the fallback tree
    const traversalResult = await fallbackTreeRegistry.traverse(
      treeKey,
      traversalContext,
    );

    // Determine if this is a fallback recommendation
    const isFallback = traversalResult.path.length > 1;
    const fallbackDepth = isFallback ? traversalResult.maxDepthReached : 0;

    // Build explanation
    let explanation: string;
    if (traversalResult.terminalFailure) {
      explanation = `No viable strategy found. ${traversalResult.terminalFailureReason}. Evaluated ${traversalResult.nodesEvaluated} strategies.`;
    } else if (isFallback) {
      const failedNodes = extractFailedNodes(traversalResult);
      const failedReasons = failedNodes
        .slice(0, 3)
        .map(n => `${n.nodeName} (${n.reason})`)
        .join(', ');
      explanation = `Recommended ${traversalResult.selectedNode?.name} as fallback. Primary strategies unavailable: ${failedReasons}${failedNodes.length > 3 ? '...' : ''}.`;
    } else {
      explanation = `Recommended primary strategy ${traversalResult.selectedNode?.name}. All health checks passed.`;
    }

    return {
      recommendedStrategy: traversalResult.selectedNode
        ? {
            id: traversalResult.selectedNode.id,
            name: traversalResult.selectedNode.name,
          }
        : null,
      traversalResult,
      isFallback,
      fallbackDepth,
      explanation,
      recommendedAt: new Date(now).toISOString(),
    };
  } finally {
    // Clean up temporary tree
    fallbackTreeRegistry.removeTree(treeKey);
  }
}

/**
 * Get recommendation with rotation candidates integration
 *
 * This variant integrates with the Strategy Rotation Service to prioritize
 * candidates based on rotation decisions before applying fallback logic.
 */
export async function getRotatedStrategyRecommendation(
  context: StrategyRecommendationContext,
): Promise<RecommendationResult> {
  // Convert available strategies to rotation candidates
  const rotationCandidates: RotationCandidate[] = context.availableStrategies.map(
    (strategy) => ({
      id: strategy.id,
      name: strategy.name,
      score: strategy.priority ?? 0, // Use priority as initial score
      fetchedAt: new Date().toISOString(),
    }),
  );

  // Get rotation decision
  const rotationDecision = rotationRegistry.evaluate(rotationCandidates);

  // If rotation selected a strategy, prioritize it in the fallback tree
  let prioritizedStrategies = [...context.availableStrategies];
  if (rotationDecision.action === 'rotate' && rotationDecision.toId) {
    const rotatedStrategy = context.availableStrategies.find(
      (s) => s.id === rotationDecision.toId,
    );
    if (rotatedStrategy) {
      // Move rotated strategy to front with highest priority
      prioritizedStrategies = [
        { ...rotatedStrategy, priority: 999 },
        ...context.availableStrategies.filter((s) => s.id !== rotationDecision.toId),
      ];
    }
  }

  // Get recommendation with prioritized strategies
  return getStrategyRecommendation({
    ...context,
    availableStrategies: prioritizedStrategies,
  });
}

/**
 * Get degraded path recommendation for a specific protocol
 *
 * This function provides protocol-specific fallback recommendations,
 * useful when a particular protocol is experiencing issues.
 */
export async function getProtocolFallbackRecommendation(
  protocolId: string,
  context: StrategyRecommendationContext,
): Promise<RecommendationResult> {
  // Filter strategies by protocol
  const protocolStrategies = context.availableStrategies.filter(
    (s) => s.protocolId === protocolId,
  );

  if (protocolStrategies.length === 0) {
    // No strategies for this protocol, fall back to all strategies
    return getStrategyRecommendation(context);
  }

  // Check if protocol is excluded by failover service
  const excludedProtocols = failoverRegistry.excludedProtocols();
  const isProtocolExcluded = excludedProtocols.includes(protocolId);

  if (isProtocolExcluded) {
    // Protocol is excluded, recommend from other protocols
    const otherProtocolStrategies = context.availableStrategies.filter(
      (s) => s.protocolId !== protocolId,
    );
    return getStrategyRecommendation({
      ...context,
      availableStrategies: otherProtocolStrategies,
    });
  }

  // Protocol is healthy, recommend from its strategies
  return getStrategyRecommendation({
    ...context,
    availableStrategies: protocolStrategies,
  });
}

/**
 * Get recommendation with health-based prioritization
 *
 * This variant fetches health scores for all strategies first,
 * then prioritizes them by health score before fallback traversal.
 */
export async function getHealthPrioritizedRecommendation(
  context: StrategyRecommendationContext,
): Promise<RecommendationResult> {
  // Fetch health scores for all strategies
  const healthScores = await Promise.all(
    context.availableStrategies.map(async (strategy) => {
      try {
        const health = await strategyHealthEngine.calculateHealthScore(
          strategy.id,
          strategy.name,
        );
        return {
          strategy,
          healthScore: health.overallScore,
          status: health.status,
        };
      } catch {
        return {
          strategy,
          healthScore: 0,
          status: 'critical' as const,
        };
      }
    }),
  );

  // Sort by health score (descending)
  const sortedStrategies = healthScores
    .sort((a, b) => b.healthScore - a.healthScore)
    .map((item) => ({
      ...item.strategy,
      priority: item.healthScore, // Use health score as priority
    }));

  // Get recommendation with health-prioritized strategies
  return getStrategyRecommendation({
    ...context,
    availableStrategies: sortedStrategies,
  });
}

// ── Monitoring and Analytics ─────────────────────────────────────────────

/**
 * Get fallback tree statistics for monitoring
 */
export function getFallbackTreeStatistics() {
  const history = fallbackTreeRegistry.getTraversalHistory(1000);

  const stats = {
    totalTraversals: history.length,
    successfulTraversals: history.filter((h) => !h.terminalFailure).length,
    failedTraversals: history.filter((h) => h.terminalFailure).length,
    averageNodesEvaluated:
      history.reduce((sum, h) => sum + h.nodesEvaluated, 0) / history.length || 0,
    averageDepthReached:
      history.reduce((sum, h) => sum + h.maxDepthReached, 0) / history.length || 0,
    mostCommonFailureReasons: getMostCommonFailureReasons(history),
  };

  return stats;
}

/**
 * Get most common failure reasons from traversal history
 */
function getMostCommonFailureReasons(history: TraversalResult[]): Array<{
  reason: string;
  count: number;
}> {
  const reasonCounts = new Map<string, number>();

  history.forEach((result) => {
    if (result.terminalFailure && result.terminalFailureReason) {
      const count = reasonCounts.get(result.terminalFailureReason) || 0;
      reasonCounts.set(result.terminalFailureReason, count + 1);
    }
  });

  return Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

/**
 * Get recent recommendation history for a specific strategy
 */
export function getStrategyRecommendationHistory(
  strategyId: string,
  limit = 50,
): TraversalResult[] {
  const allHistory = fallbackTreeRegistry.getTraversalHistory(limit);
  return allHistory.filter((result) =>
    result.path.some((step) => step.nodeId === strategyId),
  );
}
