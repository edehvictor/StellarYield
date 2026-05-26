/**
 * Hierarchical Strategy Fallback Tree Service
 *
 * Represents fallback choices as a structured tree so strategy services can
 * choose the next-best safe alternative under failure or exclusion.
 *
 * Design principles:
 *   - Tree structure: Each node represents a strategy/protocol with ordered
 *     children as fallback options
 *   - Safety-first: Traversal never routes into blocked or unhealthy branches
 *   - Deterministic: Given the same tree and health state, traversal always
 *     produces the same result
 *   - Audit trail: Every traversal decision is logged with reasons
 *   - Cycle detection: Prevents infinite loops in malformed trees
 *   - Terminal failure: Gracefully handles cases where no viable path exists
 *
 * Tree semantics:
 *   - Nodes are evaluated in depth-first, left-to-right order
 *   - A node is viable if it passes all safety checks (health, blocklist, etc.)
 *   - If a node fails, traversal continues to its children in order
 *   - If all children fail, traversal backtracks to the parent's siblings
 *   - Terminal failure occurs when no viable path exists from the root
 *
 * Security:
 *   - Fallback traversal must never route into blocked or unhealthy branches
 *   - Health checks are mandatory before considering any node
 *   - Blocklist checks prevent routing to explicitly excluded strategies
 */

// ── Types ───────────────────────────────────────────────────────────────

export type NodeStatus = 'healthy' | 'degraded' | 'critical' | 'blocked' | 'unknown';

export interface FallbackNode {
  /** Unique identifier for this strategy/protocol */
  id: string;
  /** Human-readable name */
  name: string;
  /** Ordered list of fallback options (children in the tree) */
  fallbacks: FallbackNode[];
  /** Optional priority weight for tie-breaking (higher = preferred) */
  priority?: number;
  /** Optional metadata for custom filtering */
  metadata?: Record<string, unknown>;
}

export interface HealthCheck {
  /** Current health status of the node */
  status: NodeStatus;
  /** Overall health score (0-100) */
  score: number;
  /** Timestamp of last health check */
  checkedAt: string;
  /** Specific reasons for current status */
  reasons: string[];
}

export interface BlocklistCheck {
  /** Whether the node is explicitly blocked */
  isBlocked: boolean;
  /** Reason for block (if blocked) */
  reason?: string;
  /** Timestamp of blocklist check */
  checkedAt: string;
}

export interface TraversalContext {
  /** Health check function for a node */
  checkHealth: (nodeId: string) => Promise<HealthCheck> | HealthCheck;
  /** Blocklist check function for a node */
  checkBlocklist: (nodeId: string) => Promise<BlocklistCheck> | BlocklistCheck;
  /** Minimum health score to consider a node viable */
  minHealthScore: number;
  /** Whether to allow degraded nodes (vs only healthy) */
  allowDegraded: boolean;
  /** Maximum traversal depth to prevent infinite loops */
  maxDepth: number;
  /** Current timestamp for age checks */
  now?: number;
}

export interface TraversalStep {
  /** Node being evaluated */
  nodeId: string;
  /** Node name */
  nodeName: string;
  /** Depth in the traversal tree */
  depth: number;
  /** Whether this node was selected */
  selected: boolean;
  /** Why this node was selected or skipped */
  reason: string;
  /** Health check result */
  health: HealthCheck;
  /** Blocklist check result */
  blocklist: BlocklistCheck;
  /** Timestamp of this step */
  timestamp: string;
}

export interface TraversalResult {
  /** The selected node (if any) */
  selectedNode: FallbackNode | null;
  /** Full traversal path with all evaluated nodes */
  path: TraversalStep[];
  /** Whether traversal reached terminal failure */
  terminalFailure: boolean;
  /** Reason for terminal failure (if applicable) */
  terminalFailureReason?: string;
  /** Total nodes evaluated */
  nodesEvaluated: number;
  /** Maximum depth reached */
  maxDepthReached: number;
  /** Timestamp when traversal completed */
  completedAt: string;
}

export interface FallbackTreeConfig {
  /** Default minimum health score */
  defaultMinHealthScore: number;
  /** Default whether to allow degraded nodes */
  defaultAllowDegraded: boolean;
  /** Default maximum traversal depth */
  defaultMaxDepth: number;
  /** Maximum size of traversal history log */
  maxHistorySize: number;
}

export const DEFAULT_FALLBACK_CONFIG: FallbackTreeConfig = {
  defaultMinHealthScore: 50,
  defaultAllowDegraded: true,
  defaultMaxDepth: 20,
  maxHistorySize: 1000,
};

// ── Traversal Engine ─────────────────────────────────────────────────────

/**
 * Check if a node is viable based on health and blocklist status
 */
function isNodeViable(
  health: HealthCheck,
  blocklist: BlocklistCheck,
  context: TraversalContext,
): { viable: boolean; reason: string } {
  // Blocklist check takes precedence
  if (blocklist.isBlocked) {
    return {
      viable: false,
      reason: `Blocked: ${blocklist.reason || 'no reason provided'}`,
    };
  }

  // Health score check
  if (health.score < context.minHealthScore) {
    return {
      viable: false,
      reason: `Health score ${health.score} below threshold ${context.minHealthScore}`,
    };
  }

  // Status-based check
  if (health.status === 'blocked') {
    return { viable: false, reason: 'Status is blocked' };
  }

  if (health.status === 'critical') {
    return { viable: false, reason: 'Status is critical' };
  }

  if (health.status === 'degraded' && !context.allowDegraded) {
    return { viable: false, reason: 'Degraded status not allowed' };
  }

  if (health.status === 'unknown') {
    return { viable: false, reason: 'Status is unknown' };
  }

  return { viable: true, reason: 'All checks passed' };
}

/**
 * Detect cycles in the fallback tree to prevent infinite loops
 */
function detectCycles(node: FallbackNode, visited: Set<string>, path: string[]): boolean {
  if (visited.has(node.id)) {
    return true;
  }

  visited.add(node.id);
  path.push(node.id);

  for (const child of node.fallbacks) {
    if (detectCycles(child, visited, [...path])) {
      return true;
    }
  }

  visited.delete(node.id);
  return false;
}

/**
 * Validate a fallback tree structure
 */
export function validateFallbackTree(root: FallbackNode): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const visited = new Set<string>();

  // Check for cycles
  if (detectCycles(root, visited, [])) {
    errors.push('Cycle detected in fallback tree');
  }

  // Check for duplicate IDs at same level
  function checkDuplicates(node: FallbackNode, ids: Set<string>): void {
    if (ids.has(node.id)) {
      errors.push(`Duplicate node ID at same level: ${node.id}`);
    }
    ids.add(node.id);

    const childIds = new Set<string>();
    for (const child of node.fallbacks) {
      checkDuplicates(child, childIds);
    }
  }

  checkDuplicates(root, new Set());

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Traverse the fallback tree to find the first viable node
 */
export async function traverseFallbackTree(
  root: FallbackNode,
  context: TraversalContext,
): Promise<TraversalResult> {
  const now = context.now ?? Date.now();
  const path: TraversalStep[] = [];
  let nodesEvaluated = 0;
  let maxDepthReached = 0;

  // Validate tree before traversal
  const validation = validateFallbackTree(root);
  if (!validation.valid) {
    return {
      selectedNode: null,
      path,
      terminalFailure: true,
      terminalFailureReason: `Invalid tree structure: ${validation.errors.join(', ')}`,
      nodesEvaluated: 0,
      maxDepthReached: 0,
      completedAt: new Date(now).toISOString(),
    };
  }

  // Depth-first traversal with backtracking
  async function traverse(
    node: FallbackNode,
    depth: number,
    visited: Set<string>,
  ): Promise<FallbackNode | null> {
    if (depth > maxDepthReached) {
      maxDepthReached = depth;
    }

    // Prevent cycles during traversal
    if (visited.has(node.id)) {
      const step: TraversalStep = {
        nodeId: node.id,
        nodeName: node.name,
        depth,
        selected: false,
        reason: 'Cycle detected - node already visited',
        health: {
          status: 'unknown',
          score: 0,
          checkedAt: new Date(now).toISOString(),
          reasons: [],
        },
        blocklist: {
          isBlocked: true,
          reason: 'Cycle detected',
          checkedAt: new Date(now).toISOString(),
        },
        timestamp: new Date(now).toISOString(),
      };
      path.push(step);
      nodesEvaluated++;
      return null;
    }

    if (depth > context.maxDepth) {
      const step: TraversalStep = {
        nodeId: node.id,
        nodeName: node.name,
        depth,
        selected: false,
        reason: `Max depth ${context.maxDepth} exceeded`,
        health: {
          status: 'unknown',
          score: 0,
          checkedAt: new Date(now).toISOString(),
          reasons: [],
        },
        blocklist: {
          isBlocked: false,
          checkedAt: new Date(now).toISOString(),
        },
        timestamp: new Date(now).toISOString(),
      };
      path.push(step);
      nodesEvaluated++;
      return null;
    }

    visited.add(node.id);

    // Perform health and blocklist checks
    const health = await Promise.resolve(context.checkHealth(node.id));
    const blocklist = await Promise.resolve(context.checkBlocklist(node.id));
    nodesEvaluated++;

    const { viable, reason } = isNodeViable(health, blocklist, context);

    const step: TraversalStep = {
      nodeId: node.id,
      nodeName: node.name,
      depth,
      selected: viable,
      reason,
      health,
      blocklist,
      timestamp: new Date(now).toISOString(),
    };
    path.push(step);

    if (viable) {
      return node;
    }

    // Try fallbacks in order
    for (const child of node.fallbacks) {
      const result = await traverse(child, depth + 1, new Set(visited));
      if (result) {
        return result;
      }
    }

    visited.delete(node.id);
    return null;
  }

  const selectedNode = await traverse(root, 0, new Set());

  return {
    selectedNode,
    path,
    terminalFailure: selectedNode === null,
    terminalFailureReason: selectedNode === null 
      ? 'No viable path found in fallback tree' 
      : undefined,
    nodesEvaluated,
    maxDepthReached,
    completedAt: new Date(now).toISOString(),
  };
}

// ── Fallback Tree Registry ───────────────────────────────────────────────

/**
 * Stateful registry for managing fallback trees and traversal history
 */
export class FallbackTreeRegistry {
  private trees: Map<string, FallbackNode> = new Map();
  private traversalHistory: TraversalResult[] = [];
  private config: FallbackTreeConfig;

  constructor(config: Partial<FallbackTreeConfig> = {}) {
    this.config = { ...DEFAULT_FALLBACK_CONFIG, ...config };
  }

  /**
   * Register a fallback tree with a given key
   */
  registerTree(key: string, root: FallbackNode): void {
    const validation = validateFallbackTree(root);
    if (!validation.valid) {
      throw new Error(`Invalid fallback tree: ${validation.errors.join(', ')}`);
    }
    this.trees.set(key, root);
  }

  /**
   * Get a registered fallback tree
   */
  getTree(key: string): FallbackNode | undefined {
    return this.trees.get(key);
  }

  /**
   * Remove a registered fallback tree
   */
  removeTree(key: string): boolean {
    return this.trees.delete(key);
  }

  /**
   * Get all registered tree keys
   */
  getTreeKeys(): string[] {
    return Array.from(this.trees.keys());
  }

  /**
   * Traverse a registered fallback tree with default context
   */
  async traverse(
    key: string,
    contextOverrides: Partial<TraversalContext> = {},
  ): Promise<TraversalResult> {
    const root = this.trees.get(key);
    if (!root) {
      throw new Error(`Fallback tree not found: ${key}`);
    }

    const context: TraversalContext = {
      checkHealth: contextOverrides.checkHealth ?? (() => ({
        status: 'healthy',
        score: 100,
        checkedAt: new Date().toISOString(),
        reasons: [],
      })),
      checkBlocklist: contextOverrides.checkBlocklist ?? (() => ({
        isBlocked: false,
        checkedAt: new Date().toISOString(),
      })),
      minHealthScore: contextOverrides.minHealthScore ?? this.config.defaultMinHealthScore,
      allowDegraded: contextOverrides.allowDegraded ?? this.config.defaultAllowDegraded,
      maxDepth: contextOverrides.maxDepth ?? this.config.defaultMaxDepth,
      now: contextOverrides.now,
    };

    const result = await traverseFallbackTree(root, context);
    this.recordTraversal(result);
    return result;
  }

  /**
   * Get recent traversal history
   */
  getTraversalHistory(limit = 50): TraversalResult[] {
    if (limit <= 0) return [];
    const slice = this.traversalHistory.slice(-limit);
    return slice.slice().reverse();
  }

  /**
   * Get traversal history for a specific tree
   */
  getTraversalHistoryForTree(key: string, limit = 50): TraversalResult[] {
    const all = this.getTraversalHistory(limit);
    return all.filter(r => r.path.length > 0 && r.path[0].nodeId === key);
  }

  /**
   * Clear traversal history
   */
  clearHistory(): void {
    this.traversalHistory = [];
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<FallbackTreeConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): FallbackTreeConfig {
    return { ...this.config };
  }

  /**
   * Reset registry state (test hook)
   */
  reset(): void {
    this.trees.clear();
    this.traversalHistory = [];
  }

  private recordTraversal(result: TraversalResult): void {
    this.traversalHistory.push(result);
    if (this.traversalHistory.length > this.config.maxHistorySize) {
      this.traversalHistory.splice(
        0,
        this.traversalHistory.length - this.config.maxHistorySize,
      );
    }
  }
}

// ── Export singleton instance ─────────────────────────────────────────────

export const fallbackTreeRegistry = new FallbackTreeRegistry();

// ── Helper functions ─────────────────────────────────────────────────────

/**
 * Create a simple fallback tree from a flat list of strategies
 * Strategies are ordered by priority (higher priority = tried first)
 */
export function createFallbackTreeFromList(
  strategies: Array<{ id: string; name: string; priority?: number }>,
): FallbackNode {
  if (strategies.length === 0) {
    throw new Error('Cannot create fallback tree from empty list');
  }

  // Sort by priority (descending), then by ID for determinism
  const sorted = [...strategies].sort((a, b) => {
    const aPriority = a.priority ?? 0;
    const bPriority = b.priority ?? 0;
    if (bPriority !== aPriority) return bPriority - aPriority;
    return a.id.localeCompare(b.id);
  });

  // Create a chain: first -> second -> third -> ...
  const root: FallbackNode = {
    id: sorted[0].id,
    name: sorted[0].name,
    priority: sorted[0].priority,
    fallbacks: [],
  };

  let current = root;
  for (let i = 1; i < sorted.length; i++) {
    const next: FallbackNode = {
      id: sorted[i].id,
      name: sorted[i].name,
      priority: sorted[i].priority,
      fallbacks: [],
    };
    current.fallbacks.push(next);
    current = next;
  }

  return root;
}

/**
 * Format traversal result for logging/monitoring
 */
export function formatTraversalResult(result: TraversalResult): string {
  if (result.terminalFailure) {
    return `Terminal failure: ${result.terminalFailureReason}. Evaluated ${result.nodesEvaluated} nodes.`;
  }

  return `Selected ${result.selectedNode?.name} (${result.selectedNode?.id}) after evaluating ${result.nodesEvaluated} nodes at max depth ${result.maxDepthReached}.`;
}

/**
 * Extract failed nodes from a traversal result
 */
export function extractFailedNodes(result: TraversalResult): Array<{
  nodeId: string;
  nodeName: string;
  reason: string;
  healthScore: number;
}> {
  return result.path
    .filter(step => !step.selected)
    .map(step => ({
      nodeId: step.nodeId,
      nodeName: step.nodeName,
      reason: step.reason,
      healthScore: step.health.score,
    }));
}
